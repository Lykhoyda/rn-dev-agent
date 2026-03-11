import type { NavigatorScreenParams } from '@react-navigation/native';

export type HomeStackParams = {
  HomeMain: undefined;
  Feed: undefined;
};

export type ProfileStackParams = {
  ProfileMain: undefined;
  Settings: undefined;
  ReloadTest: undefined;
};

export type TabParams = {
  HomeTab: NavigatorScreenParams<HomeStackParams>;
  ProfileTab: NavigatorScreenParams<ProfileStackParams>;
  NotificationsTab: undefined;
};

export type RootStackParams = {
  Tabs: NavigatorScreenParams<TabParams>;
  ErrorLab: undefined;
  DeepLink: { id: string };
};
