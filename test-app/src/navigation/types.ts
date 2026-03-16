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

export type NotificationsStackParams = {
  NotificationsMain: undefined;
  NotificationDetail: { id: string };
};

export type TasksStackParams = {
  TasksMain: undefined;
  TaskDetail: { id: string };
};

export type TabParams = {
  HomeTab: NavigatorScreenParams<HomeStackParams>;
  ProfileTab: NavigatorScreenParams<ProfileStackParams>;
  NotificationsTab: NavigatorScreenParams<NotificationsStackParams>;
  TasksTab: NavigatorScreenParams<TasksStackParams>;
};

export type RootStackParams = {
  Tabs: NavigatorScreenParams<TabParams>;
  ProfileEditModal: undefined;
  ErrorLab: undefined;
  DeepLink: { id: string };
};
