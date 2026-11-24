import { expect, it } from 'bun:test';
import type { MedoChat } from '../../shared/medo.ts';
import { observeMedoChats, parseMedoReadState } from './medoReadState.ts';

const chat = (patch: Partial<MedoChat> = {}): MedoChat => ({ id: 'thread', title: 'Fix sidebar', project: 'st', cwd: '/fixture', updated: 10, archived: false, unavailable: null, folder: null, paneId: 'pane', status: 'idle', ...patch });

it('seeds history quietly, then remembers an unseen completion across reloads', () => {
  const baseline = observeMedoChats(new Map(), [chat({ status: 'working' })], null);
  expect(baseline.get('thread')?.unread).toBe(false);
  const restored = parseMedoReadState(JSON.stringify([...baseline]));
  const finished = observeMedoChats(restored, [chat()], null);
  expect(finished.get('thread')?.unread).toBe(true);
  expect(observeMedoChats(finished, [chat()], null)).toBe(finished);
  const read = observeMedoChats(finished, [chat()], 'thread');
  expect(read.get('thread')?.unread).toBe(false);
  expect(observeMedoChats(read, [chat()], null)).toBe(read);
});

it('tracks updates missed between polls and does not read a hidden or covered pane', () => {
  const read = observeMedoChats(new Map(), [chat()], 'thread');
  const updated = chat({ updated: 20, status: 'done' });
  expect(observeMedoChats(read, [updated], null).get('thread')?.unread).toBe(true);
  expect(observeMedoChats(read, [updated], 'thread').get('thread')?.unread).toBe(false);
  expect(observeMedoChats(read, [chat({ updated: 9 })], null)).toBe(read);
});

it('a completion becomes unread after leaving a working conversation even with the same timestamp', () => {
  const working = observeMedoChats(new Map(), [chat({ status: 'working' })], 'thread');
  expect(observeMedoChats(working, [chat({ status: 'done' })], null).get('thread')?.unread).toBe(true);
  expect(observeMedoChats(working, [chat({ status: 'done' })], 'thread').get('thread')?.unread).toBe(false);
  expect(observeMedoChats(working, [chat({ status: 'waiting' })], null).get('thread')?.unread).toBe(false);
});

it('keeps thread identities separate and prunes removed history', () => {
  const baseline = observeMedoChats(new Map(), [chat(), chat({ id: 'other' })], null);
  const next = observeMedoChats(baseline, [chat({ updated: 20 }), chat({ id: 'other' })], 'other');
  expect(next.get('thread')?.unread).toBe(true);
  expect(next.get('other')?.unread).toBe(false);
  expect(observeMedoChats(next, [chat({ id: 'other' })], null).has('thread')).toBe(false);
});

it('ignores corrupt storage and invalid entries', () => {
  for (const value of [null, '{broken', '{}', 'null', '[null,3,["x",null],["x",{"updated":"10","working":false,"unread":true}]]']) expect(parseMedoReadState(value).size).toBe(0);
});
