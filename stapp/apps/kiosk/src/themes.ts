import alpenglow from './landscapes/alpenglow.webp';
import canopy from './landscapes/canopy.webp';
import dune from './landscapes/dune.webp';
import bluehour from './landscapes/bluehour.webp';

export const themes = [
  { id: 'alpenglow', label: 'Alpenglow', image: alpenglow, accent: '#ff9674', dial: '#382e2b', sky: '#231d1c', ticks: '#ffe9df' },
  { id: 'canopy', label: 'Canopy', image: canopy, accent: '#b2d9a2', dial: '#2c423b', sky: '#192e29', ticks: '#e1f1d9' },
  { id: 'dune', label: 'Dune', image: dune, accent: '#dc8f47', dial: '#604738', sky: '#d8c9b8', ticks: '#fcf2dc' },
  { id: 'bluehour', label: 'Blue Hour', image: bluehour, accent: '#b1b8ff', dial: '#303750', sky: '#171c32', ticks: '#e8eaff' }
] as const;

export type Theme = typeof themes[number];
export function findTheme(id?: string): Theme {
  return themes.find(theme => theme.id === id) ?? themes[0];
}
