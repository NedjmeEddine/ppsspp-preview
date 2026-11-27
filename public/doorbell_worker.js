let i32 = null;
let missFutexIndex = 0;

self.onmessage = (e) => {
    const msg = e.data || {};
    if (msg.type === 'INIT') {
        i32 = new Int32Array(msg.wasmMemory.buffer);
        missFutexIndex = msg.missFutexIndex;
        self.postMessage({ type: 'INIT_OK' });
    } else if (msg.type === 'WAIT') {
        if (!i32) {
            self.postMessage({ type: 'WAKE', res: 'error' });
            return;
        }
        const res = Atomics.wait(i32, missFutexIndex, msg.expected, msg.timeoutMs);
        self.postMessage({ type: 'WAKE', res });
    }
};
