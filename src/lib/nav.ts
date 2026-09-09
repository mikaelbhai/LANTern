export type Screen =
  | 'home'
  | 'chats'
  | 'calls'
  | 'files'
  | 'theatre'
  | 'games'
  | 'network'
  | 'settings';

export const SCREEN_TITLES: Record<Screen, string> = {
  home: 'Home',
  chats: 'Chats',
  calls: 'Calls',
  files: 'Files',
  theatre: 'Theatre',
  games: 'Games',
  network: 'Network',
  settings: 'Settings',
};
