import test from 'node:test';
import assert from 'node:assert/strict';
import { setVideoEnabled } from '../lib/media-toggle.mjs';

function fakeStream(tracks) {
  return { getVideoTracks: () => tracks };
}

test('пауза трансляции: переключаются только video-треки и только изменённые', () => {
  const video = { enabled: true };
  const video2 = { enabled: false };
  const stream = fakeStream([video, video2]);

  assert.equal(setVideoEnabled(stream, false), 1, 'трек с enabled=false уже выключен — не считается');
  assert.equal(video.enabled, false);
  assert.equal(video2.enabled, false);

  assert.equal(setVideoEnabled(stream, true), 2);
  assert.equal(video.enabled, true);
});

test('пауза трансляции: пустой/кривой стрим не роняет, возвращает 0', () => {
  assert.equal(setVideoEnabled(fakeStream([]), false), 0);
  assert.equal(setVideoEnabled(undefined, false), 0);
  assert.equal(setVideoEnabled({}, false), 0, 'стрим без getVideoTracks безвреден');
});

test('пауза трансляции: audio-треки не трогаются (звук не наша забота)', () => {
  const stream = {
    getVideoTracks: () => [],
    getAudioTracks: () => [{ enabled: true }],
  };
  assert.equal(setVideoEnabled(stream, false), 0);
});
