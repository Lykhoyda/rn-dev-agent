import type { NavigatorScreenParams } from '@react-navigation/native';

export type HomeStackParams = {
  HomeMain: undefined;
  Feed: undefined;
  Dashboard: undefined;
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
  AllTasks: undefined;
};

export type TabParams = {
  HomeTab: NavigatorScreenParams<HomeStackParams>;
  ProfileTab: NavigatorScreenParams<ProfileStackParams>;
  NotificationsTab: NavigatorScreenParams<NotificationsStackParams>;
  TasksTab: NavigatorScreenParams<TasksStackParams>;
};

export type RootStackParams = {
  Onboarding: undefined;
  Tabs: NavigatorScreenParams<TabParams>;
  ProfileEditModal: undefined;
  TaskWizard: undefined;
  ErrorLab: undefined;
  DeepLink: { id: string };
};
