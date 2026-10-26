import { expect, test } from 'bun:test';
import { overlaps, rainBudget, scramble } from '../web/src/skins/nightcity/geometry.ts';

test('rain keeps a light baseline outside bursts and caps phone resources', () => {
  for(const phone of [true,false]) for(const burst of [true,false]) {
    const budget=rainBudget(phone,burst);
    expect(budget.count).toBeGreaterThanOrEqual(phone?120:360);
    expect(budget.count).toBeLessThanOrEqual(phone?180:540);
    expect(budget.fps).toBeLessThanOrEqual(phone?20:30);
    expect(budget.dpr).toBeLessThanOrEqual(phone?1.5:2);
    expect(budget.opacity).toBeGreaterThanOrEqual(.35);
    expect(budget.opacity).toBeLessThanOrEqual(.6);
  }
});
test('HUD decode preserves units/spacing and ends on the exact synthetic value', () => {
  const exact='12h 07m / 26 of 30';
  expect(scramble(exact,0,()=>.9)).toBe('99h 99m / 99 of 99');
  expect(scramble(exact,8,()=>.9)).toBe(exact);
  expect(scramble('No activity',0,()=>.9)).toBe('No activity');
});
test('sprite swept bounds respect the protected text/control clearance', () => {
  const control={left:100,top:100,right:200,bottom:140};
  expect(overlaps({left:80,top:105,right:90,bottom:115},control,12)).toBe(true);
  expect(overlaps({left:70,top:105,right:80,bottom:115},control,12)).toBe(false);
  expect(overlaps({left:110,top:110,right:116,bottom:116},control)).toBe(true);
});
