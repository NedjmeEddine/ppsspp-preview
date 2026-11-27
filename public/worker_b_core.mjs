import * as Offsets from './vfs_offsets.js';

export const VFS_ALLOC_DEMAND = 0;
export const VFS_ALLOC_PREFETCH = 1;
export const VFS_ALREADY_PRESENT = -1;
export const VFS_NO_VICTIM = -2;

// Standard CRC32 table for save slot validation (§5.6)
const CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    CRC32_TABLE[i] = c >>> 0;
}

export function crc32(buffer) {
    let c = 0xFFFFFFFF;
    const u8 = new Uint8Array(buffer.buffer || buffer, buffer.byteOffset || 0, buffer.byteLength);
    for (let i = 0; i < u8.length; i++) {
        c = CRC32_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
}

export function validateManifest(dataView, byteLength) {
    if (byteLength < 32) throw new Error("Manifest too short");
    const magic = dataView.getUint32(0, true);
    if (magic !== 0x4D534656) throw new Error("Invalid manifest magic");
    const version = dataView.getUint16(4, true);
    if (version !== 1) throw new Error("Unsupported manifest version");
    const topK = dataView.getUint16(6, true);
    if (topK < 1 || topK > 16) throw new Error("Invalid TopK");

    const archiveByteSize = dataView.getBigUint64(8, true);
    const buildEtagHash = dataView.getBigUint64(16, true);
    const totalBlocks = dataView.getUint32(24, true);
    const blockShift = dataView.getUint8(28);
    const neighborIdBytes = dataView.getUint8(29);
    const packShift = dataView.getUint8(30);
    const defaultPoolMB = dataView.getUint8(31);

    if (blockShift !== 16 && blockShift !== 18 && blockShift !== 19) {
        throw new Error("Invalid blockShift");
    }
    if (neighborIdBytes !== 2 && neighborIdBytes !== 4) {
        throw new Error("Invalid neighborIdBytes");
    }
    if (packShift > (28 - blockShift)) {
        throw new Error("Invalid packShift");
    }
    if (defaultPoolMB < 16) {
        throw new Error("Invalid defaultPoolMB");
    }
    if (totalBlocks < 1 || totalBlocks > 4194304) {
        throw new Error("TotalBlocks out of bounds (1..4194304)");
    }

    const blockSize = 1 << blockShift;
    const expectedBlocks = Math.ceil(Number(archiveByteSize) / blockSize);
    if (totalBlocks !== expectedBlocks) {
        throw new Error("TotalBlocks mismatch with archiveByteSize");
    }

    const expectedBodyLen = 32 + totalBlocks * topK * neighborIdBytes;
    if (byteLength !== expectedBodyLen) {
        throw new Error("Manifest byte length mismatch");
    }

    const sentinel = (neighborIdBytes === 4) ? 0xFFFFFFFF : 0xFFFF;
    let off = 32;
    for (let i = 0; i < totalBlocks * topK; i++) {
        let n = (neighborIdBytes === 4) ? dataView.getUint32(off, true) : dataView.getUint16(off, true);
        off += neighborIdBytes;
        if (n !== sentinel && n >= totalBlocks) {
            throw new Error(`Neighbor ID out of bounds at slot ${i}: ${n}`);
        }
    }

    return {
        magic, version, topK, archiveByteSize, buildEtagHash,
        totalBlocks, blockShift, neighborIdBytes, packShift, defaultPoolMB
    };
}

export function computeGeometry(header, poolOverrideMB) {
    let effectivePoolMB = poolOverrideMB ? Math.max(16, poolOverrideMB) : header.defaultPoolMB;
    if (effectivePoolMB < 16) effectivePoolMB = 16;
    if (effectivePoolMB > 64) effectivePoolMB = 64;

    const blockSize = 1 << header.blockShift;
    const rawFrames = Math.floor((effectivePoolMB * 1048576) / blockSize);
    let numSets = Math.floor(Math.min(rawFrames, 4096) / 8);
    if (numSets < 1) numSets = 1;
    if (numSets > 512) numSets = 512;

    const totalFrames = numSets * 8;
    const arenaBytes = Offsets.VFS_ARENA_SLAB_OFFSET + totalFrames * blockSize;
    const arenaPages = Math.ceil(arenaBytes / 65536);

    return { effectivePoolMB, numSets, totalFrames, arenaBytes, arenaPages, blockSize };
}

export function setIndex(blockId, numSets) {
    if (numSets === 0) return 0;
    return ((Math.imul(blockId, 0x9E3779B1) >>> 16) % numSets);
}

export function calcAge(clockNow, lruTick, flags) {
    if (flags & Offsets.FLAG_COLD_HINT) {
        return 0xFFFFFFFF >>> 0;
    }
    return ((clockNow - lruTick) >>> 0);
}

export function allocate(ways, blockId, kind, clockNow) {
    for (let w = 0; w < 8; w++) {
        const way = ways[w];
        if (way.block_id === blockId && (way.state === Offsets.FRAME_LOADING || way.state === Offsets.FRAME_READY)) {
            return VFS_ALREADY_PRESENT;
        }
    }

    const emptyWays = [];
    const cleanWays = [];
    const dirtyWays = [];

    for (let w = 0; w < 8; w++) {
        const way = ways[w];
        if (way.state === Offsets.FRAME_EMPTY) {
            emptyWays.push(w);
        } else if (way.state === Offsets.FRAME_READY && way.pin_count === 0) {
            if (way.flags & Offsets.FLAG_DIRTY_OPFS) {
                dirtyWays.push(w);
            } else {
                cleanWays.push(w);
            }
        }
    }

    function selectBest(list) {
        let best = -1;
        let bestAge = 0;
        let bestBid = 0xFFFFFFFF;

        for (let i = 0; i < list.length; i++) {
            const w = list[i];
            const age = calcAge(clockNow, ways[w].lru_tick, ways[w].flags);
            const bid = ways[w].block_id;

            if (best === -1 || age > bestAge ||
               (age === bestAge && (w < best || (w === best && bid < bestBid)))) {
                best = w;
                bestAge = age;
                bestBid = bid;
            }
        }
        return best;
    }

    if (kind === VFS_ALLOC_PREFETCH) {
        if (emptyWays.length + cleanWays.length <= Offsets.VFS_PREFETCH_MIN_FREE) {
            return VFS_NO_VICTIM;
        }
        if (emptyWays.length > 0) return emptyWays[0];
        if (cleanWays.length > 0) return selectBest(cleanWays);
        return VFS_NO_VICTIM;
    }

    // Demand
    if (emptyWays.length > 0) return emptyWays[0];
    if (cleanWays.length > 0) return selectBest(cleanWays);
    if (dirtyWays.length > 0) return selectBest(dirtyWays);
    return VFS_NO_VICTIM;
}

export function coalesce(blockIds, packShift, maxRun) {
    if (!blockIds || blockIds.length === 0 || maxRun === 0) return [];
    const runs = [];
    let i = 0;

    while (i < blockIds.length) {
        const start = blockIds[i];
        let len = 1;
        const currentPack = (packShift > 0) ? (start >>> packShift) : 0;

        while (i + 1 < blockIds.length && len < maxRun) {
            const nextId = blockIds[i + 1];
            const nextPack = (packShift > 0) ? (nextId >>> packShift) : 0;
            if (nextId === start + len && nextPack === currentPack) {
                len++;
                i++;
            } else {
                break;
            }
        }

        runs.push({ start_block: start, count: len });
        i++;
    }
    return runs;
}

export function planPrefetch(triggerBlock, neighbors, topK, totalBlocks, packShift, isResidentL1, isResidentL2) {
    const R = Offsets.VFS_RUN_AHEAD;
    const cap = Offsets.VFS_MAX_PREFETCH_BLOCKS;

    const candidates = [];
    const candSet = new Set();

    function addWindow(startId, rank) {
        if (startId >= totalBlocks || startId === Offsets.VFS_INVALID_BLOCK) return;
        const endId = Math.min(startId + R, totalBlocks - 1);
        for (let bid = startId; bid <= endId; bid++) {
            if (!candSet.has(bid)) {
                candSet.add(bid);
                candidates.push({ block_id: bid, rank });
            }
        }
    }

    if (neighbors && triggerBlock < totalBlocks) {
        for (let i = 0; i < topK; i++) {
            const n = neighbors[triggerBlock * topK + i];
            addWindow(n, i);
        }
    }

    if (triggerBlock + 1 < totalBlocks) {
        addWindow(triggerBlock + 1, topK);
    }

    const filtered = [];
    for (let c = 0; c < candidates.length && filtered.length < cap; c++) {
        const bid = candidates[c].block_id;
        if (isResidentL1 && isResidentL1(bid)) continue;
        filtered.push(candidates[c]);
    }

    const promoteBlocks = [];
    const netCandidates = [];

    for (let i = 0; i < filtered.length; i++) {
        const bid = filtered[i].block_id;
        if (isResidentL2 && isResidentL2(bid)) {
            if (promoteBlocks.length < cap) promoteBlocks.push(bid);
        } else {
            netCandidates.push(filtered[i]);
        }
    }

    netCandidates.sort((a, b) => a.block_id - b.block_id);
    const netIds = netCandidates.map(c => c.block_id);
    const runs = coalesce(netIds, packShift, Offsets.VFS_MAX_COALESCE_BLOCKS);

    for (let r = 0; r < runs.length; r++) {
        let minRank = 0xFFFFFFFF;
        const rStart = runs[r].start_block;
        const rEnd = rStart + runs[r].count;
        for (let i = 0; i < netCandidates.length; i++) {
            if (netCandidates[i].block_id >= rStart && netCandidates[i].block_id < rEnd) {
                if (netCandidates[i].rank < minRank) minRank = netCandidates[i].rank;
            }
        }
        runs[r].rank = (minRank === 0xFFFFFFFF) ? 0 : minRank;
    }

    // Sort runs by rank ascending, ties to start_block ascending
    runs.sort((a, b) => {
        if (a.rank !== b.rank) return a.rank - b.rank;
        return a.start_block - b.start_block;
    });

    return { runs, promote_blocks: promoteBlocks };
}

export class WorkerBCore {
    constructor(opts) {
        this.wasmMemory = opts.wasmMemory;
        this.arenaOffset = opts.arenaOffset;
        this.manifest = opts.manifest;
        this.neighbors = opts.neighbors;
        this.fetchFn = opts.fetchFn || ((url, reqOpts) => fetch(url, reqOpts));
        this.opfsHandle = opts.opfsHandle || null;
        this.clockFn = opts.clockFn || (() => performance.now());
        this.postMessageFn = opts.postMessageFn || (() => {});

        this.opfsEnabled = !!this.opfsHandle;
        this.buildEtagHex = this.manifest.buildEtagHash.toString(16).padStart(16, '0');
        this.numSets = this.manifest.numSets;
        this.totalFrames = this.numSets * 8;
        this.blockSize = 1 << this.manifest.blockShift;

        this.buffer = this.wasmMemory.buffer;
        this.i32 = new Int32Array(this.buffer, this.arenaOffset);
        this.u32 = new Uint32Array(this.buffer, this.arenaOffset);
        this.u8  = new Uint8Array(this.buffer, this.arenaOffset);
        this.dataView = new DataView(this.buffer, this.arenaOffset);

        this.pendingDemand = new Set();
        this.pendingBitmap = new Uint8Array(Math.ceil(this.manifest.totalBlocks / 8));
        this.persistedBitmap = new Uint8Array(Math.ceil(this.manifest.totalBlocks / 8));
        this.lastDemandSeqSeen = 0;
        this.lastFlushTime = this.clockFn();
        this.blocksWrittenSinceFlush = 0;
        this.lastOPFSFlushTime = this.clockFn();
        this.stopTelemetry = false;
        this.pendingDrainBank = null;
        this.hasDirtyFrames = false;
        this.frameStates = new Uint8Array(this.totalFrames);
        this.saves = (opts && opts.initialSaves instanceof Map) ? opts.initialSaves : new Map();
        this.onSaveWrite = (opts && typeof opts.onSaveWrite === 'function') ? opts.onSaveWrite : null;

        this.opfsHeaderSize = 32;
        this.bitmapSize = Math.ceil(this.manifest.totalBlocks / 8);
        this.bitmapOffset = this.opfsHeaderSize;
        this.payloadBaseOffset = this.bitmapOffset + this.bitmapSize;
        this.initOPFS();
    }

    initOPFS() {
        if (!this.opfsHandle) return;
        try {
            const sz = this.opfsHandle.getSize ? this.opfsHandle.getSize() : 0;
            if (sz >= this.payloadBaseOffset) {
                const hdrBuf = new Uint8Array(32);
                this.opfsHandle.read(hdrBuf, { at: 0 });
                const dv = new DataView(hdrBuf.buffer, hdrBuf.byteOffset, 32);
                const magic = dv.getUint32(0, true);
                const etag = dv.getBigUint64(4, true);
                if (magic === 0x46504F56 && etag === this.manifest.buildEtagHash) {
                    this.opfsHandle.read(this.persistedBitmap, { at: this.bitmapOffset });
                    this.pendingBitmap.set(this.persistedBitmap);
                    return;
                }
            }
            const hdr = new Uint8Array(32);
            const dv = new DataView(hdr.buffer);
            dv.setUint32(0, 0x46504F56, true);
            dv.setBigUint64(4, this.manifest.buildEtagHash, true);
            dv.setUint32(12, this.manifest.totalBlocks, true);
            dv.setUint8(16, this.manifest.blockShift);
            this.opfsHandle.write(hdr, { at: 0 });
            this.persistedBitmap.fill(0);
            this.pendingBitmap.fill(0);
            this.opfsHandle.write(this.persistedBitmap, { at: this.bitmapOffset });
            if (this.opfsHandle.flush) this.opfsHandle.flush();
        } catch (e) {
            console.warn('OPFS init failed, disabling L2 cache:', e);
            this.opfsHandle = null;
            this.opfsEnabled = false;
        }
    }

    writeBlockToOPFS(blockId, slabSrcOffset) {
        if (!this.opfsHandle) return;
        try {
            const fileOff = this.payloadBaseOffset + blockId * this.blockSize;
            const chunk = this.u8.subarray(slabSrcOffset, slabSrcOffset + this.blockSize);
            this.opfsHandle.write(chunk, { at: fileOff });
            this.pendingBitmap[blockId >>> 3] |= (1 << (blockId & 7));
            this.blocksWrittenSinceFlush++;
        } catch (e) {
            console.warn('OPFS write failed:', e);
        }
    }

    readBlockFromOPFS(blockId, slabDstOffset) {
        if (!this.opfsHandle) return false;
        try {
            const fileOff = this.payloadBaseOffset + blockId * this.blockSize;
            const chunk = this.u8.subarray(slabDstOffset, slabDstOffset + this.blockSize);
            const n = this.opfsHandle.read(chunk, { at: fileOff });
            if (n === this.blockSize || n === undefined) {
                Atomics.add(this.u32, Offsets.CTRL_L2_OPFS_HITS_OFFSET >>> 2, 1);
                return true;
            }
        } catch (e) {
            console.warn('OPFS read failed:', e);
        }
        return false;
    }

    flushOPFS() {
        if (!this.opfsHandle || this.blocksWrittenSinceFlush === 0) return;
        try {
            if (this.opfsHandle.flush) this.opfsHandle.flush();
            this.opfsHandle.write(this.pendingBitmap, { at: this.bitmapOffset });
            if (this.opfsHandle.flush) this.opfsHandle.flush();
            this.persistedBitmap.set(this.pendingBitmap);
            this.blocksWrittenSinceFlush = 0;
            this.lastOPFSFlushTime = this.clockFn();
        } catch (e) {
            console.warn('OPFS flush failed:', e);
        }
    }

    idleOPFSWriteBehind() {
        if (!this.opfsHandle) return;
        let wroteAny = false;
        for (let f = 0; f < this.totalFrames; f++) {
            const entry = this.readFrameEntry(f);
            if (entry.state === Offsets.FRAME_READY && (entry.flags & Offsets.FLAG_DIRTY_OPFS)) {
                if (entry.block_id !== Offsets.VFS_INVALID_BLOCK) {
                    const slabOff = Offsets.VFS_ARENA_SLAB_OFFSET + f * this.blockSize;
                    this.writeBlockToOPFS(entry.block_id, slabOff);
                    const base = (Offsets.VFS_ARENA_DIR_OFFSET + f * Offsets.PAGE_FRAME_ENTRY_SIZE) >>> 2;
                    Atomics.and(this.u32, base + 4, ~Offsets.FLAG_DIRTY_OPFS);
                    wroteAny = true;
                }
            }
        }
        if (wroteAny) {
            this.flushOPFS();
        }
        this.hasDirtyFrames = false;
    }

    readFrameEntry(frameIdx) {
        const base = (Offsets.VFS_ARENA_DIR_OFFSET + frameIdx * Offsets.PAGE_FRAME_ENTRY_SIZE) >>> 2;
        return {
            block_id: Atomics.load(this.u32, base),
            state: Atomics.load(this.u32, base + 1),
            pin_count: Atomics.load(this.i32, base + 2),
            lru_tick: Atomics.load(this.u32, base + 3),
            flags: Atomics.load(this.u32, base + 4)
        };
    }

    writeFrameEntry(frameIdx, blockId, state, flags) {
        const base = (Offsets.VFS_ARENA_DIR_OFFSET + frameIdx * Offsets.PAGE_FRAME_ENTRY_SIZE) >>> 2;
        if (blockId !== undefined) Atomics.store(this.u32, base, blockId);
        if (flags !== undefined) Atomics.store(this.u32, base + 4, flags);
        if (state !== undefined) Atomics.store(this.u32, base + 1, state);
    }

    // Dekker eviction handshake: FRAME_EVICTING -> verify pin_count == 0 -> write-through -> FRAME_LOADING
    tryClaimVictim(frameIdx, newBlockId) {
        const base = (Offsets.VFS_ARENA_DIR_OFFSET + frameIdx * Offsets.PAGE_FRAME_ENTRY_SIZE) >>> 2;
        const curState = Atomics.load(this.u32, base + 1);

        if (curState === Offsets.FRAME_EMPTY) {
            if (Atomics.compareExchange(this.u32, base + 1, Offsets.FRAME_EMPTY, Offsets.FRAME_EVICTING) !== Offsets.FRAME_EMPTY) {
                return false;
            }
        } else if (curState === Offsets.FRAME_READY) {
            Atomics.store(this.u32, base + 1, Offsets.FRAME_EVICTING);
            if (Atomics.load(this.i32, base + 2) !== 0) {
                Atomics.store(this.u32, base + 1, Offsets.FRAME_READY);
                return false;
            }
            const oldBid = Atomics.load(this.u32, base);
            const oldFlags = Atomics.load(this.u32, base + 4);
            if ((oldFlags & Offsets.FLAG_DIRTY_OPFS) && oldBid !== Offsets.VFS_INVALID_BLOCK) {
                const slabOff = Offsets.VFS_ARENA_SLAB_OFFSET + frameIdx * this.blockSize;
                this.writeBlockToOPFS(oldBid, slabOff);
            }
        } else {
            return false;
        }

        Atomics.store(this.u32, base, newBlockId);
        Atomics.store(this.u32, base + 4, 0);
        Atomics.store(this.u32, base + 1, Offsets.FRAME_LOADING);
        return true;
    }

    allocateBlock(blockId, kind, clockNow) {
        const set = setIndex(blockId, this.numSets);
        const ways = [];
        for (let w = 0; w < 8; w++) ways.push(this.readFrameEntry(set * 8 + w));
        const victim = allocate(ways, blockId, kind, clockNow);
        if (victim < 0) return -1;
        const frameIdx = set * 8 + victim;
        return this.tryClaimVictim(frameIdx, blockId) ? frameIdx : -1;
    }

    rollbackFrame(frameIdx, isDemand) {
        const base = (Offsets.VFS_ARENA_DIR_OFFSET + frameIdx * Offsets.PAGE_FRAME_ENTRY_SIZE) >>> 2;
        // Step 1: clear block_id and flags
        Atomics.store(this.u32, base, Offsets.VFS_INVALID_BLOCK);
        Atomics.store(this.u32, base + 4, 0);
        // Step 2: store state = FRAME_EMPTY
        Atomics.store(this.u32, base + 1, Offsets.FRAME_EMPTY);

        // Step 3: ONLY IF DEMAND: io_error_gen++ (Trap 6 fix)
        if (isDemand) {
            Atomics.add(this.u32, Offsets.IO_ERROR_GEN_INDEX, 1);
        }
        // Step 4: io_futex++ and notify all
        Atomics.add(this.i32, Offsets.IO_FUTEX_INDEX, 1);
        Atomics.notify(this.i32, Offsets.IO_FUTEX_INDEX, Infinity);
    }

    markFrameReady(frameIdx) {
        const base = (Offsets.VFS_ARENA_DIR_OFFSET + frameIdx * Offsets.PAGE_FRAME_ENTRY_SIZE) >>> 2;
        const now = Atomics.add(this.u32, Offsets.CTRL_GLOBAL_LRU_CLOCK_OFFSET >>> 2, 1) + 1;
        Atomics.store(this.u32, base + 3, now);
        Atomics.store(this.u32, base + 1, Offsets.FRAME_READY);
        Atomics.add(this.i32, Offsets.IO_FUTEX_INDEX, 1);
        Atomics.notify(this.i32, Offsets.IO_FUTEX_INDEX, Infinity);
    }

    isResidentL1(blockId) {
        const s = setIndex(blockId, this.numSets);
        for (let w = 0; w < 8; w++) {
            const entry = this.readFrameEntry(s * 8 + w);
            if (entry.block_id === blockId && (entry.state === Offsets.FRAME_LOADING || entry.state === Offsets.FRAME_READY)) {
                return true;
            }
        }
        return false;
    }

    isResidentL2(blockId) {
        const byteIdx = blockId >>> 3;
        const bitMask = 1 << (blockId & 7);
        return ((this.pendingBitmap[byteIdx] | this.persistedBitmap[byteIdx]) & bitMask) !== 0;
    }

    async fetchRun(run, isDemand) {
        const packIdx = (this.manifest.packShift > 0) ? (run.start_block >>> this.manifest.packShift) : 0;
        const blockInPack = (this.manifest.packShift > 0) ? (run.start_block & ((1 << this.manifest.packShift) - 1)) : run.start_block;
        const s = blockInPack * this.blockSize;
        const e = s + run.count * this.blockSize - 1;
        const packHex = packIdx.toString().padStart(4, '0');
        const url = `/packs/pak_${this.buildEtagHex}_${packHex}.bin`;

        let resp;
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                resp = await this.fetchFn(url, {
                    headers: { 'Range': `bytes=${s}-${e}` },
                    cache: 'no-store'
                });
                if (resp.status === 206) break;
                if (resp.status === 404) {
                    Atomics.store(this.u32, Offsets.CTRL_BUILD_ROTATED_FLAG_OFFSET >>> 2, 1);
                    this.postMessageFn({ type: 'BUILD_ROTATED', reason: '404 from pack' });
                    return false;
                }
                if (resp.status === 416 || (resp.status >= 400 && resp.status < 500 && resp.status !== 429)) {
                    return false;
                }
            } catch (err) {
                // network error, retry
            }
            await new Promise(r => setTimeout(r, attempt === 0 ? 50 : 150));
        }

        if (!resp || resp.status !== 206) return false;

        Atomics.add(this.u32, Offsets.CTRL_NETWORK_FETCHES_OFFSET >>> 2, 1);

        const bodyBuf = await resp.arrayBuffer();
        if (bodyBuf.byteLength !== run.count * this.blockSize) {
            return false;
        }

        const bodyU8 = new Uint8Array(bodyBuf);
        for (let b = 0; b < run.count; b++) {
            const bid = run.start_block + b;
            const set = setIndex(bid, this.numSets);
            for (let w = 0; w < 8; w++) {
                const f = set * 8 + w;
                const entry = this.readFrameEntry(f);
                if (entry.block_id === bid && entry.state === Offsets.FRAME_LOADING) {
                    const slabOff = Offsets.VFS_ARENA_SLAB_OFFSET + f * this.blockSize;
                    this.u8.set(bodyU8.subarray(b * this.blockSize, (b + 1) * this.blockSize), slabOff);
                    const flags = this.opfsEnabled ? Offsets.FLAG_DIRTY_OPFS : 0;
                    if (flags) this.hasDirtyFrames = true;
                    this.writeFrameEntry(f, undefined, undefined, flags);
                    this.markFrameReady(f);
                    break;
                }
            }
        }
        return true;
    }

    flushTelemetry(reason) {
        if (this.stopTelemetry) return;

        let bankToDrain = this.pendingDrainBank;
        if (bankToDrain !== null && bankToDrain !== undefined) {
            // Check if pending drain bank has quiesced
            if (Atomics.load(this.u32, (Offsets.CTRL_TELEM_INFLIGHT_OFFSET >>> 2) + bankToDrain) > 0) {
                return;
            }
            this.pendingDrainBank = null;
        } else {
            const old = Atomics.load(this.u32, Offsets.CTRL_ACTIVE_TELEM_BANK_OFFSET >>> 2) & 1;
            const count = Atomics.load(this.u32, (Offsets.CTRL_TELEM_BANK_COUNT_OFFSET >>> 2) + old);
            if (count === 0) return;

            // 1. Flip active bank
            Atomics.store(this.u32, Offsets.CTRL_ACTIVE_TELEM_BANK_OFFSET >>> 2, old ^ 1);

            // 2. Quiesce (bounded spin to prevent infinite freeze if a thread terminated)
            let spins = 0;
            while (Atomics.load(this.u32, (Offsets.CTRL_TELEM_INFLIGHT_OFFSET >>> 2) + old) > 0 && spins < 50000) {
                spins++;
            }

            if (Atomics.load(this.u32, (Offsets.CTRL_TELEM_INFLIGHT_OFFSET >>> 2) + old) > 0) {
                // Abort and defer draining this bank until in-flight drops to 0
                this.pendingDrainBank = old;
                return;
            }

            bankToDrain = old;
        }

        // 3. Read count and copy
        const recBytes = this.manifest.neighborIdBytes * 2;
        const maxRecords = Offsets.VFS_TELEM_BANK_BYTES / recBytes;
        const n = Math.min(Atomics.load(this.u32, (Offsets.CTRL_TELEM_BANK_COUNT_OFFSET >>> 2) + bankToDrain), maxRecords);
        Atomics.store(this.u32, (Offsets.CTRL_TELEM_BANK_COUNT_OFFSET >>> 2) + bankToDrain, 0);
        this.lastFlushTime = this.clockFn();
        if (n === 0) return;

        const bankOff = (bankToDrain === 0) ? Offsets.VFS_ARENA_TELEM0_OFFSET : Offsets.VFS_ARENA_TELEM1_OFFSET;
        const slice = this.u8.slice(bankOff, bankOff + n * recBytes);

        // 4. Send POST unawaited (Spec §5.7)
        const url = `/telemetry/transitions?build=${this.buildEtagHex}`;
        this.fetchFn(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: slice,
            keepalive: (reason === 'pagehide')
        }).then(resp => {
            if (resp.status === 409) {
                Atomics.store(this.u32, Offsets.CTRL_BUILD_ROTATED_FLAG_OFFSET >>> 2, 1);
                this.postMessageFn({ type: 'BUILD_ROTATED', reason: '409 from telemetry' });
            } else if (resp.status === 413 || resp.status === 507) {
                this.stopTelemetry = true;
            }
        }).catch(() => {
            // Drop without retry per spec §5.7
        });
    }

    completeSaveOp(res, opState) {
        Atomics.store(this.i32, Offsets.CTRL_SAVE_RESULT_OFFSET >>> 2, res);
        const prev = Atomics.compareExchange(this.u32, Offsets.CTRL_SAVE_ABANDONED_OFFSET >>> 2, 0, 2);
        if (prev === 0) {
            Atomics.store(this.u32, Offsets.CTRL_SAVE_OP_STATE_OFFSET >>> 2, opState);
            Atomics.add(this.i32, Offsets.SAVE_FUTEX_INDEX, 1);
            Atomics.notify(this.i32, Offsets.SAVE_FUTEX_INDEX, Infinity);
        } else {
            Atomics.store(this.u32, Offsets.CTRL_SAVE_ABANDONED_OFFSET >>> 2, 0);
            Atomics.store(this.u32, Offsets.CTRL_SAVE_OP_STATE_OFFSET >>> 2, Offsets.SAVE_OP_IDLE);
            Atomics.store(this.i32, Offsets.SAVE_LOCK_INDEX, 0);
            Atomics.notify(this.i32, Offsets.SAVE_LOCK_INDEX, 1);
        }
    }
    handleSaveOp() {
        const op = Atomics.load(this.u32, Offsets.CTRL_SAVE_OP_STATE_OFFSET >>> 2);
        if (op === Offsets.SAVE_OP_IDLE || op === Offsets.SAVE_OP_DONE || op === Offsets.SAVE_OP_ERROR) {
            return;
        }

        try {
            // Decode filename
            const nameBytes = this.u8.subarray(Offsets.CTRL_SAVE_FILENAME_OFFSET, Offsets.CTRL_SAVE_FILENAME_OFFSET + 64);
            let len = 0;
            while (len < 64 && nameBytes[len] !== 0) len++;
            const filename = new TextDecoder().decode(nameBytes.subarray(0, len));

            if (op === Offsets.SAVE_OP_WRITE) {
                const byteLen = Atomics.load(this.u32, Offsets.CTRL_SAVE_BYTE_LEN_OFFSET >>> 2);
                const payload = this.u8.slice(Offsets.VFS_ARENA_SAVE_OFFSET, Offsets.VFS_ARENA_SAVE_OFFSET + byteLen);
                const crc = crc32(payload);
                const slotBuf = new Uint8Array(16 + byteLen);
                const dv = new DataView(slotBuf.buffer);
                const prevSlot = this.saves.get(filename);
                let seq = 1;
                if (prevSlot && prevSlot.byteLength >= 16) {
                    const prevDv = new DataView(prevSlot.buffer, prevSlot.byteOffset, prevSlot.byteLength);
                    if (prevDv.getUint32(0, true) === 0x56534156) {
                        seq = (prevDv.getUint32(4, true) + 1) >>> 0;
                    }
                }
                dv.setUint32(0, 0x56534156, true);
                dv.setUint32(4, seq, true);
                dv.setUint32(8, byteLen, true);
                dv.setUint32(12, crc, true);
                slotBuf.set(payload, 16);
                this.saves.set(filename, slotBuf);
                if (this.onSaveWrite) {
                    try { this.onSaveWrite(filename, slotBuf); } catch (e) {}
                }

                this.completeSaveOp(Offsets.VFS_OK, Offsets.SAVE_OP_DONE);
            } else if (op === Offsets.SAVE_OP_READ) {
                const slotBuf = this.saves.get(filename);
                let res = Offsets.VFS_OK;
                let opState = Offsets.SAVE_OP_DONE;
                if (!slotBuf) {
                    res = Offsets.VFS_ERR_NOT_FOUND;
                    opState = Offsets.SAVE_OP_ERROR;
                } else if (slotBuf.byteLength < 16) {
                    res = Offsets.VFS_ERR_IO;
                    opState = Offsets.SAVE_OP_ERROR;
                } else {
                    const dv = new DataView(slotBuf.buffer, slotBuf.byteOffset, slotBuf.byteLength);
                    const magic = dv.getUint32(0, true);
                    const byteLen = dv.getUint32(8, true);
                    const expectedCrc = dv.getUint32(12, true);
                    if (magic !== 0x56534156 || slotBuf.byteLength < 16 + byteLen) {
                        res = Offsets.VFS_ERR_IO;
                        opState = Offsets.SAVE_OP_ERROR;
                    } else {
                        const payload = slotBuf.subarray(16, 16 + byteLen);
                        if (crc32(payload) !== expectedCrc) {
                            res = Offsets.VFS_ERR_IO;
                            opState = Offsets.SAVE_OP_ERROR;
                        } else {
                            this.u8.set(payload, Offsets.VFS_ARENA_SAVE_OFFSET);
                            Atomics.store(this.u32, Offsets.CTRL_SAVE_BYTE_LEN_OFFSET >>> 2, byteLen);
                            res = Offsets.VFS_OK;
                            opState = Offsets.SAVE_OP_DONE;
                        }
                    }
                }
                this.completeSaveOp(res, opState);
            }
        } catch (err) {
            this.completeSaveOp(Offsets.VFS_ERR_IO, Offsets.SAVE_OP_ERROR);
        }
    }

    getHudSnapshot() {
        for (let f = 0; f < this.totalFrames; f++) {
            const entry = this.readFrameEntry(f);
            let byte = entry.state & 0x3;
            if (entry.pin_count > 0) byte |= (1 << 2);
            if (entry.flags & Offsets.FLAG_DIRTY_OPFS) byte |= (1 << 3);
            if (entry.flags & Offsets.FLAG_COLD_HINT) byte |= (1 << 4);
            this.frameStates[f] = byte;
        }

        const dv = this.dataView || new DataView(this.buffer, this.arenaOffset);
        return {
            tsMs: this.clockFn(),
            blockShift: this.manifest.blockShift,
            totalBlocks: Atomics.load(this.u32, Offsets.CTRL_TOTAL_BLOCKS_OFFSET >>> 2),
            totalFrames: this.totalFrames,
            l1Hits: dv.getBigUint64(Offsets.CTRL_L1_HITS_OFFSET, true),
            l1Misses: dv.getBigUint64(Offsets.CTRL_L1_MISSES_OFFSET, true),
            totalStallNs: dv.getBigUint64(Offsets.CTRL_TOTAL_STALL_NS_OFFSET, true),
            l2OpfsHits: Atomics.load(this.u32, Offsets.CTRL_L2_OPFS_HITS_OFFSET >>> 2),
            networkFetches: Atomics.load(this.u32, Offsets.CTRL_NETWORK_FETCHES_OFFSET >>> 2),
            frameStates: this.frameStates.slice()
        };
    }

    async runPass() {
        const expected = Atomics.load(this.i32, Offsets.MISS_FUTEX_INDEX);

        // 1. Drain miss ring
        const drained = [];
        while (true) {
            const r = Atomics.load(this.u32, Offsets.CTRL_MISS_READ_IDX_OFFSET >>> 2);
            const w = Atomics.load(this.u32, Offsets.CTRL_MISS_WRITE_IDX_OFFSET >>> 2);
            if (r === w) break;

            const slot = (Offsets.CTRL_MISS_RING_OFFSET >>> 2) + (r & Offsets.VFS_MISS_RING_MASK);
            const bid = Atomics.load(this.u32, slot);
            if (bid === Offsets.VFS_INVALID_BLOCK) break;

            Atomics.store(this.u32, slot, Offsets.VFS_INVALID_BLOCK);
            Atomics.store(this.u32, Offsets.CTRL_MISS_READ_IDX_OFFSET >>> 2, r + 1);
            drained.push(bid);
        }

        for (const bid of drained) this.pendingDemand.add(bid);

        // Demand intake
        const clockNow = Atomics.load(this.u32, Offsets.CTRL_GLOBAL_LRU_CLOCK_OFFSET >>> 2);
        const toFetch = [];
        for (const bid of Array.from(this.pendingDemand)) {
            if (this.isResidentL1(bid)) {
                this.pendingDemand.delete(bid);
                continue;
            }

            const f = this.allocateBlock(bid, VFS_ALLOC_DEMAND, clockNow);
            if (f < 0) continue;

            if (this.isResidentL2(bid)) {
                const slabOff = Offsets.VFS_ARENA_SLAB_OFFSET + f * this.blockSize;
                if (this.readBlockFromOPFS(bid, slabOff)) {
                    this.markFrameReady(f);
                    this.pendingDemand.delete(bid);
                    continue;
                }
            }

            toFetch.push(bid);
            this.pendingDemand.delete(bid);
        }

        if (toFetch.length > 0) {
            toFetch.sort((a, b) => a - b);
            const runs = coalesce(toFetch, this.manifest.packShift, Offsets.VFS_MAX_COALESCE_BLOCKS);
            for (const r of runs) {
                // Sequential stride run-ahead: prefetch adjacent blocks in same HTTP 206 range
                r.demandCount = r.count;
                const targetCount = Math.min(r.count + 3, Offsets.VFS_MAX_COALESCE_BLOCKS);
                while (r.count < targetCount) {
                    const nextBid = r.start_block + r.count;
                    if (nextBid >= this.manifest.totalBlocks) break;
                    if (this.manifest.packShift > 0 && (nextBid >>> this.manifest.packShift) !== (r.start_block >>> this.manifest.packShift)) break;
                    if (this.isResidentL1(nextBid) || this.isResidentL2(nextBid)) break;
                    if (this.allocateBlock(nextBid, VFS_ALLOC_PREFETCH, clockNow) < 0) break;
                    this.pendingDemand.delete(nextBid);
                    r.count++;
                }
            }

            for (let i = 0; i < runs.length; i += Offsets.VFS_MAX_INFLIGHT_DEMAND) {
                const batch = runs.slice(i, i + Offsets.VFS_MAX_INFLIGHT_DEMAND);
                await Promise.all(batch.map(async (r) => {
                    const ok = await this.fetchRun(r, true);
                    if (!ok) {
                        for (let b = 0; b < r.count; b++) {
                            const bid = r.start_block + b;
                            const isDemandBlock = b < r.demandCount;
                            const set = setIndex(bid, this.numSets);
                            for (let w = 0; w < 8; w++) {
                                const f = set * 8 + w;
                                const entry = this.readFrameEntry(f);
                                if (entry.block_id === bid && entry.state === Offsets.FRAME_LOADING) {
                                    this.rollbackFrame(f, isDemandBlock);
                                }
                            }
                        }
                    }
                }));
            }
        }

        // Markov prefetch check
        const currentDemandSeq = Atomics.load(this.u32, Offsets.CTRL_DEMAND_SEQ_OFFSET >>> 2);
        if (currentDemandSeq !== this.lastDemandSeqSeen && this.neighbors) {
            this.lastDemandSeqSeen = currentDemandSeq;
            const triggerBlock = Atomics.load(this.u32, Offsets.CTRL_LAST_DEMAND_BLOCK_OFFSET >>> 2);
            if (triggerBlock < this.manifest.totalBlocks) {
                const plan = planPrefetch(
                    triggerBlock,
                    this.neighbors,
                    this.manifest.topK,
                    this.manifest.totalBlocks,
                    this.manifest.packShift,
                    (b) => this.isResidentL1(b),
                    (b) => this.isResidentL2(b)
                );

                // 1. Promote L2 blocks
                for (const pbid of plan.promote_blocks) {
                    if (this.isResidentL1(pbid)) continue;
                    const pf = this.allocateBlock(pbid, VFS_ALLOC_PREFETCH, clockNow);
                    if (pf >= 0) {
                        const slabOff = Offsets.VFS_ARENA_SLAB_OFFSET + pf * this.blockSize;
                        if (this.readBlockFromOPFS(pbid, slabOff)) {
                            this.markFrameReady(pf);
                        } else {
                            this.rollbackFrame(pf, false);
                        }
                    }
                }

                // 2. Network prefetch runs
                const maxRuns = Math.min(plan.runs.length, Offsets.VFS_MAX_INFLIGHT_PREFETCH);
                for (let rIdx = 0; rIdx < maxRuns; rIdx++) {
                    const r = plan.runs[rIdx];
                    const allocatedBlocks = [];
                    for (let b = 0; b < r.count; b++) {
                        const pbid = r.start_block + b;
                        if (this.isResidentL1(pbid)) continue;
                        const pf = this.allocateBlock(pbid, VFS_ALLOC_PREFETCH, clockNow);
                        if (pf >= 0) {
                            allocatedBlocks.push({ frame: pf, block_id: pbid });
                        }
                    }

                    if (allocatedBlocks.length > 0) {
                        this.fetchRun(r, false).then(ok => {
                            if (!ok) {
                                for (const ab of allocatedBlocks) {
                                    this.rollbackFrame(ab.frame, false);
                                }
                            }
                        }).catch(() => {
                            for (const ab of allocatedBlocks) {
                                this.rollbackFrame(ab.frame, false);
                            }
                        });
                    }
                }
            }
        }

        // Idle OPFS write-behind
        if (this.pendingDemand.size === 0 && this.hasDirtyFrames) {
            this.idleOPFSWriteBehind();
        }

        // 2. Service save op
        this.handleSaveOp();

        // 3. Telemetry check: 50% capacity or 60s timer
        const bank = Atomics.load(this.u32, Offsets.CTRL_ACTIVE_TELEM_BANK_OFFSET >>> 2) & 1;
        const count = Atomics.load(this.u32, (Offsets.CTRL_TELEM_BANK_COUNT_OFFSET >>> 2) + bank);
        const recBytes = this.manifest.neighborIdBytes * 2;
        const maxRecords = Offsets.VFS_TELEM_BANK_BYTES / recBytes;
        const now = this.clockFn();
        if (count >= maxRecords / 2) {
            this.flushTelemetry('bank-50%');
        } else if (count > 0 && (now - this.lastFlushTime >= 60000)) {
            this.flushTelemetry('timer-60s');
        }

        return expected;
    }
}
