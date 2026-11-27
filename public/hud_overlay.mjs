export function createHudOverlay(canvas) {
    const ctx = canvas.getContext('2d');

    function getFrameColor(byte) {
        const state = byte & 0x3;
        const isPinned = (byte & (1 << 2)) !== 0;
        const isDirty = (byte & (1 << 3)) !== 0;
        const isCold = (byte & (1 << 4)) !== 0;

        if (state === 0) return '#1e293b'; // FRAME_EMPTY (slate-800)
        if (state === 1) return '#f59e0b'; // FRAME_LOADING (amber-500)
        if (isPinned) return '#06b6d4';    // PINNED (cyan-500)
        if (isCold) return '#3b82f6';      // COLD_HINT (blue-500)
        if (isDirty) return '#8b5cf6';     // DIRTY_OPFS (violet-500)
        return '#10b981';                  // FRAME_READY (emerald-500)
    }

    return {
        render: (snapshot, extraMetrics = {}) => {
            if (!snapshot || !canvas) return;
            const width = canvas.width;
            const height = canvas.height;
            ctx.clearRect(0, 0, width, height);

            const {
                totalFrames = 256,
                frameStates = new Uint8Array(0),
                l1Hits = 0n,
                l1Misses = 0n,
                l2OpfsHits = 0,
                networkFetches = 0,
                totalStallNs = 0n
            } = snapshot;

            const {
                activeVramMb = 0,
                budgetVramMb = 0,
                streamedMb = 0,
                coldHints = 0,
                gpuStatus = 'Active',
                storageMode = 'stream-and-cache',
                vramLabel = null
            } = extraMetrics;

            // Background panel layout calculation
            const panelW = Math.min(360, width - 20);
            const panelX = 10;
            const panelY = 10;
            const gridX = panelX + 12;
            const gridY = panelY + 32;
            const cols = 16;
            const rows = Math.ceil(totalFrames / cols);
            const cellSize = Math.floor((panelW - 24) / cols);
            const legendY = gridY + rows * cellSize + 12;
            const textY = legendY + 22;
            const panelH = (textY + 9 * 15 + 16) - panelY;

            ctx.fillStyle = 'rgba(15, 23, 42, 0.88)';
            ctx.strokeStyle = '#334155';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.roundRect(panelX, panelY, panelW, panelH, 8);
            ctx.fill();
            ctx.stroke();

            // Header
            ctx.fillStyle = '#38bdf8';
            ctx.font = '600 13px monospace';
            ctx.fillText('OUT-OF-CORE MEMORY HUD', panelX + 12, panelY + 22);

            // Frame states grid (e.g. 16 cols x N rows)
            for (let i = 0; i < totalFrames; i++) {
                const r = Math.floor(i / cols);
                const c = i % cols;
                const byte = (i < frameStates.length) ? frameStates[i] : 0;
                ctx.fillStyle = getFrameColor(byte);
                ctx.fillRect(gridX + c * cellSize, gridY + r * cellSize, cellSize - 1, cellSize - 1);
            }

            // Legend
            const legend = [
                { label: 'Ready', color: '#10b981' },
                { label: 'Load', color: '#f59e0b' },
                { label: 'Pin', color: '#06b6d4' },
                { label: 'Cold', color: '#3b82f6' },
                { label: 'OPFS', color: '#8b5cf6' },
                { label: 'Free', color: '#1e293b' }
            ];
            let lx = gridX;
            ctx.font = '10px monospace';
            for (const item of legend) {
                ctx.fillStyle = item.color;
                ctx.fillRect(lx, legendY, 8, 8);
                ctx.fillStyle = '#94a3b8';
                ctx.fillText(item.label, lx + 11, legendY + 7);
                lx += 52;
            }

            // Numeric Metrics
            ctx.font = '11px monospace';
            ctx.fillStyle = '#f8fafc';

            const totalLookups = Number(BigInt(l1Hits) + BigInt(l1Misses));
            const hitRatio = totalLookups > 0 ? ((Number(l1Hits) / totalLookups) * 100).toFixed(1) : '0.0';
            const stallMs = (Number(totalStallNs) / 1000000).toFixed(1);

            const vramText = vramLabel || (budgetVramMb > 0
                ? `${activeVramMb.toFixed(1)} / ${budgetVramMb.toFixed(1)} MB`
                : 'Unified Slab');

            const lines = [
                `L1 RAM Hit Ratio : ${hitRatio}% (${l1Hits}/${totalLookups})`,
                `L2 OPFS SSD Hits : ${l2OpfsHits}`,
                `Network 206 Fetches: ${networkFetches}`,
                `Total Stall Latency: ${stallMs} ms`,
                `Active VRAM Cache  : ${vramText}`,
                `Streamed Bytes     : ${streamedMb.toFixed(2)} MB`,
                `Cold Hints Issued  : ${coldHints}`,
                `GPU Pipeline       : ${gpuStatus}`,
                `Storage Tier       : ${storageMode}`
            ];

            let lineY = textY;
            for (const line of lines) {
                ctx.fillStyle = line.includes('Hit Ratio') ? '#34d399' : '#cbd5e1';
                ctx.fillText(line, gridX, lineY);
                lineY += 15;
            }
        }
    };
}
