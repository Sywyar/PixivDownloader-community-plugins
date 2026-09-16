import path from 'node:path';
import fs from 'node:fs';
import { prepareSubmission as pinnedSubmission } from '../submission-sdk.mjs';

// 仅供开发回归：生产入口始终验证固定发行物，不接受本地 classpath 覆盖。
export function prepareSubmission() {
    const sdk = pinnedSubmission();
    const classes = process.env.COMMUNITY_TEST_SDK_CLASSES;
    if (classes) {
        if (!fs.statSync(classes).isDirectory()) throw new Error('TEST_SDK_CLASSES_INVALID');
        sdk.classpath = classes + path.delimiter + sdk.classpath;
    }
    return sdk;
}
