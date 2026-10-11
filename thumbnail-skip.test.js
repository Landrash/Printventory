#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  THUMB_SKIP_SIZE,
  THUMB_SKIP_MESH,
  THUMB_SKIP_TIMEOUT,
  isThumbSkipToken,
  thumbSkipErrorTag,
  thumbnailErrorTagSentence,
  isPermanentThumbnailSkipError,
  headlessSkipTokenForError,
  settleThumbnailAttempt,
  failureReasonErrorTag,
  describeThumbnailFailure,
  groupForceFailures,
  thumbnailJobFinishedMessage
} = require('./thumbnail-skip');

function test(name, fn) {
  try {
    fn();
    console.log(`ok ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}:`, err.message);
    process.exitCode = 1;
  }
}

test('skip tokens are recognized', () => {
  assert.strictEqual(isThumbSkipToken(THUMB_SKIP_SIZE), true);
  assert.strictEqual(isThumbSkipToken(THUMB_SKIP_MESH), true);
  assert.strictEqual(isThumbSkipToken(THUMB_SKIP_TIMEOUT), true);
  assert.strictEqual(isThumbSkipToken('3d.png'), false);
  assert.strictEqual(isThumbSkipToken('data:image/png;base64,abc'), false);
});

test('stl header and empty mesh errors are permanent skips', () => {
  assert.strictEqual(isPermanentThumbnailSkipError(new Error('STL header does not match the file size')), true);
  assert.strictEqual(isPermanentThumbnailSkipError(new Error('STL file too small to be valid')), true);
  assert.strictEqual(isPermanentThumbnailSkipError(new Error('Model contains no drawable mesh geometry')), true);
  assert.strictEqual(isPermanentThumbnailSkipError(new Error('No mesh geometry found in model')), true);
  assert.strictEqual(isPermanentThumbnailSkipError(new Error('Failed to fetch')), true);
  assert.strictEqual(isPermanentThumbnailSkipError(new Error('Loading model timed out after 30000ms')), false);
});

test('a failed render maps to an err tag', () => {
  assert.strictEqual(failureReasonErrorTag('No mesh geometry found in model'), 'err:no_preview');
  assert.strictEqual(failureReasonErrorTag('Could not read the file'), 'err:no_preview');
  assert.strictEqual(failureReasonErrorTag('STL header does not match the file size'), 'err:no_preview');
  assert.strictEqual(failureReasonErrorTag('Loading model timed out after 30000ms'), 'err:timeout');
  assert.strictEqual(failureReasonErrorTag('Stopped'), '');
});

test('docker log failures are tagged on force and on the safety pass', () => {
  const files = [
    {
      filePath: '/3dmodels/Einstar/Storage case.3mf',
      error: new Error('Failed to fetch')
    },
    {
      filePath: '/3dmodels/STL Files/Cessna+172+Trim+Wheel.zip::images/card_preview_faceplate.stl',
      error: new Error('No mesh geometry found in model')
    }
  ];

  const forceTags = new Map();
  const forceFailures = [];
  for (const file of files) {
    const reason = describeThumbnailFailure(file.error, '', file.error.message);
    const settled = settleThumbnailAttempt({
      filePath: file.filePath,
      force: true,
      saved: false,
      skipped: false,
      stopped: false,
      failureReason: reason
    });
    if (settled.failure) forceFailures.push(settled.failure);
    if (settled.tag) forceTags.set(file.filePath, settled.tag);
  }
  assert.deepStrictEqual(forceFailures.map((item) => item.reason), [
    'Could not read the file',
    'No mesh geometry found in model'
  ]);
  assert.strictEqual(forceTags.get(files[0].filePath), 'err:no_preview');
  assert.strictEqual(forceTags.get(files[1].filePath), 'err:no_preview');

  for (const file of files) {
    const token = headlessSkipTokenForError(file.error);
    assert.strictEqual(token, THUMB_SKIP_MESH);
    const settled = settleThumbnailAttempt({
      filePath: file.filePath,
      force: false,
      saved: false,
      skipped: true,
      stopped: false,
      skipErrorTag: thumbSkipErrorTag(token)
    });
    assert.strictEqual(settled.tag, 'err:no_preview');
    assert.strictEqual(settled.failure, null);
  }

  assert.strictEqual(headlessSkipTokenForError(new Error('WebGL context lost')), '');
  const stopped = settleThumbnailAttempt({
    filePath: files[0].filePath,
    force: true,
    stopped: true,
    failureReason: 'Could not read the file'
  });
  assert.strictEqual(stopped.tag, 'err:no_preview');
  assert.strictEqual(stopped.failure.reason, 'Could not read the file');
  const interrupted = settleThumbnailAttempt({
    filePath: '/3dmodels/still-running.stl',
    force: true,
    stopped: true,
    failureReason: ''
  });
  assert.strictEqual(interrupted.tag, '');
  assert.strictEqual(interrupted.failure, null);
  const saved = settleThumbnailAttempt({
    filePath: '/ok.stl',
    force: true,
    saved: true,
    failureReason: 'Could not render a thumbnail'
  });
  assert.strictEqual(saved.tag, '');
  assert.strictEqual(saved.clearTags, true);
});

test('stop tags failures that already finished and ignores the rest', () => {
  const attempts = [
    settleThumbnailAttempt({
      filePath: '/done-bad.stl',
      force: true,
      stopped: true,
      failureReason: 'No mesh geometry found in model'
    }),
    settleThumbnailAttempt({
      filePath: '/done-slow.step',
      force: true,
      stopped: true,
      skipped: true,
      skipErrorTag: 'err:timeout'
    }),
    settleThumbnailAttempt({
      filePath: '/in-progress.3mf',
      force: true,
      stopped: true,
      failureReason: 'Stopped'
    }),
    settleThumbnailAttempt({
      filePath: '/aborted-read.stl',
      force: true,
      stopped: true,
      failureReason: ''
    })
  ];
  const tags = new Map();
  for (const settled of attempts) {
    if (settled && settled.tag && settled.failure) tags.set(settled.failure.filePath, settled.tag);
    else if (settled && settled.tag) tags.set('skipped', settled.tag);
  }
  assert.strictEqual(tags.get('/done-bad.stl'), 'err:no_preview');
  assert.strictEqual(tags.get('skipped'), 'err:timeout');
  assert.strictEqual(tags.has('/in-progress.3mf'), false);
  assert.strictEqual(tags.has('/aborted-read.stl'), false);
  const message = thumbnailJobFinishedMessage({
    cancelled: true,
    saved: 0,
    skipped: 1,
    total: 10,
    errorTags: ['err:no_preview', 'err:timeout']
  }, 'Thumbnail generation stopped.');
  assert.match(message, /Stopped/);
  assert.match(message, /Skipped files were tagged err:no_preview and err:timeout/);
});

test('force failures with no skips still name the err tags', () => {
  const message = thumbnailJobFinishedMessage({
    saved: 0,
    skipped: 0,
    total: 229,
    errorTags: ['err:no_preview']
  }, 'Forced thumbnail generation finished.');
  assert.match(message, /No thumbnails were saved/);
  assert.match(message, /Failed files were tagged err:no_preview/);
});

test('a job that only skipped files explains why the count comes back', () => {
  const message = thumbnailJobFinishedMessage({
    cancelled: false,
    saved: 0,
    skipped: 362,
    total: 365
  }, 'Thumbnail generation completed successfully.');
  assert.match(message, /Marked 362 of 365 as skipped/);
  assert.match(message, /3 can be tried again/);
});

test('marking every file as skipped tells the user how to retry', () => {
  const message = thumbnailJobFinishedMessage({
    saved: 0,
    skipped: 365,
    total: 365
  }, 'done');
  assert.match(message, /Regenerate Thumbnails/);
});

test('a stopped job keeps the thumbnails already written', () => {
  const message = thumbnailJobFinishedMessage({
    cancelled: true,
    saved: 4,
    skipped: 20,
    total: 365
  }, 'done');
  assert.match(message, /Stopped/);
  assert.match(message, /Saved 4/);
  assert.match(message, /marked 20 as skipped/);
});

test('a partial save still names the remainder', () => {
  const message = thumbnailJobFinishedMessage({
    saved: 10,
    skipped: 0,
    total: 365
  }, 'done');
  assert.match(message, /Saved 10 of 365/);
  assert.match(message, /355 are still missing/);
});

test('skipped files are not described as still missing', () => {
  const message = thumbnailJobFinishedMessage({
    saved: 1,
    skipped: 364,
    total: 366
  }, 'done');
  assert.match(message, /Saved 1 of 366/);
  assert.match(message, /Marked 364 as skipped/);
  assert.match(message, /1 is still missing/);
  assert.doesNotMatch(message, /ones that are still missing/);
});

test('skip reasons map to err tags', () => {
  assert.strictEqual(thumbSkipErrorTag(THUMB_SKIP_SIZE), 'err:too_large');
  assert.strictEqual(thumbSkipErrorTag(THUMB_SKIP_TIMEOUT), 'err:timeout');
  assert.strictEqual(thumbSkipErrorTag(THUMB_SKIP_MESH), 'err:no_preview');
  assert.strictEqual(thumbSkipErrorTag('3d.png'), '');
});

test('the finished message names the err tags that were applied', () => {
  const message = thumbnailJobFinishedMessage({
    saved: 1,
    skipped: 2,
    total: 3,
    errorTags: ['err:timeout', 'err:too_large']
  }, 'done');
  assert.match(message, /Skipped files were tagged err:timeout and err:too_large/);
  assert.strictEqual(
    thumbnailErrorTagSentence(['err:no_preview', 'err:timeout', 'err:too_large']),
    'Skipped files were tagged err:no_preview, err:timeout, and err:too_large.'
  );
});

test('the bulk thumbnail job settles tags through the shared helper', () => {
  const source = fs.readFileSync(path.join(__dirname, 'renderer.js'), 'utf8');
  assert.match(source, /settleThumbnailAttempt\(/);
  assert.match(source, /headlessSkipTokenForError\(renderError\)/);
  assert.match(source, /headlessSkipTokenForError\(error\)/);
  assert.match(source, /failureReasonErrorTag\(described\)/);
});

test('force failures keep the parse reason and group by it', () => {
  assert.strictEqual(
    describeThumbnailFailure(new Error('STL header does not match the file size')),
    'STL header does not match the file size'
  );
  assert.strictEqual(
    describeThumbnailFailure(null, 'timeout', 'Loading model timed out after 30000ms'),
    'Loading model timed out after 30000ms'
  );
  assert.strictEqual(describeThumbnailFailure(new Error('Failed to fetch')), 'Could not read the file');
  const groups = groupForceFailures([
    { filePath: '/a.stl', reason: 'STL header does not match the file size' },
    { filePath: '/b.step', reason: 'Timed out' },
    { filePath: '/c.stl', reason: 'STL header does not match the file size' }
  ]);
  assert.strictEqual(groups.length, 2);
  assert.strictEqual(groups[0].reason, 'STL header does not match the file size');
  assert.deepStrictEqual(groups[0].filePaths, ['/a.stl', '/c.stl']);
  assert.deepStrictEqual(groups[1].filePaths, ['/b.step']);
});
