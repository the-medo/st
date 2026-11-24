import {expect, test} from 'bun:test';
import {segments} from '../components/Chart';
import {safeUrl} from './api';
test('chart segments preserve missing readings and time gaps',()=>{
  const p=[{timestamp:0,value:1},{timestamp:10,value:null},{timestamp:20,value:2},{timestamp:200,value:3}];
  expect(segments(p,10).map(s=>s.length)).toEqual([1,1,1]);
  expect(segments([{timestamp:0,value:NaN}],10)).toEqual([]);
});
test('links reject executable URLs and embedded credentials',()=>{
  expect(safeUrl('javascript:alert(1)')).toBeNull();
  expect(safeUrl('https://user:secret@example.com')).toBeNull();
  expect(safeUrl('https://example.com/a')).toBe('https://example.com/a');
});
