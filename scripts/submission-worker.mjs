import { parentPort, workerData } from 'node:worker_threads';
import { runWizard } from './submit.mjs';
import { workerTerminal } from './submission-terminal.mjs';

try {
    const outcome = await runWizard(workerData.directory, {
        uiFactory: options => workerTerminal(parentPort, workerData.cancelled, options),
    });
    parentPort.postMessage({ method: 'result', args: [outcome] });
} finally { parentPort.close(); }
