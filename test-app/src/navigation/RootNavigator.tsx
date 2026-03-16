import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { useSelector } from 'react-redux';
import type {
  RootStackParams,
  TabParams,
  HomeStackParams,
  ProfileStackParams,
  NotificationsStackParams,
  TasksStackParams,
} from './types';
import { selectUnreadCount } from '../store/slices/notificationsSlice';
import { selectActiveTaskCount } from '../store/slices/tasksSlice';
import HomeScreen from '../screens/HomeScreen';
import FeedScreen from '../screens/FeedScreen';
import ProfileScreen from '../screens/ProfileScreen';
import SettingsScreen from '../screens/SettingsScreen';
import ReloadTestScreen from '../screens/ReloadTestScreen';
import NotificationsScreen from '../screens/NotificationsScreen';
import NotificationDetailScreen from '../screens/NotificationDetailScreen';
import TasksScreen from '../screens/TasksScreen';
import TaskDetailScreen from '../screens/TaskDetailScreen';
import ErrorLabModal from '../screens/ErrorLabModal';
import ProfileEditModal from '../screens/ProfileEditModal';
import DeepLinkScreen from '../screens/DeepLinkScreen';

const RootStack = createNativeStackNavigator<RootStackParams>();
const Tab = createBottomTabNavigator<TabParams>();
const HomeStack = createNativeStackNavigator<HomeStackParams>();
const ProfileStack = createNativeStackNavigator<ProfileStackParams>();
const NotificationsStack = createNativeStackNavigator<NotificationsStackParams>();
const TasksStack = createNativeStackNavigator<TasksStackParams>();

function HomeStackNavigator() {
  return (
    <HomeStack.Navigator>
      <HomeStack.Screen name="HomeMain" component={HomeScreen} options={{ title: 'Home' }} />
      <HomeStack.Screen name="Feed" component={FeedScreen} options={{ title: 'Feed' }} />
    </HomeStack.Navigator>
  );
}

function ProfileStackNavigator() {
  return (
    <ProfileStack.Navigator>
      <ProfileStack.Screen name="ProfileMain" component={ProfileScreen} options={{ title: 'Profile' }} />
      <ProfileStack.Screen name="Settings" component={SettingsScreen} options={{ title: 'Settings' }} />
      <ProfileStack.Screen name="ReloadTest" component={ReloadTestScreen} options={{ title: 'Reload Test' }} />
    </ProfileStack.Navigator>
  );
}

function NotificationsStackNavigator() {
  return (
    <NotificationsStack.Navigator>
      <NotificationsStack.Screen
        name="NotificationsMain"
        component={NotificationsScreen}
        options={{ title: 'Notifications' }}
      />
      <NotificationsStack.Screen
        name="NotificationDetail"
        component={NotificationDetailScreen}
        options={{ title: 'Detail' }}
      />
    </NotificationsStack.Navigator>
  );
}

function TasksStackNavigator() {
  return (
    <TasksStack.Navigator>
      <TasksStack.Screen name="TasksMain" component={TasksScreen} options={{ title: 'Tasks' }} />
      <TasksStack.Screen name="TaskDetail" component={TaskDetailScreen} options={{ title: 'Task Detail' }} />
    </TasksStack.Navigator>
  );
}

function TabNavigator() {
  const unreadCount = useSelector(selectUnreadCount);
  const activeTaskCount = useSelector(selectActiveTaskCount);

  return (
    <Tab.Navigator>
      <Tab.Screen name="HomeTab" component={HomeStackNavigator} options={{ headerShown: false, title: 'Home', tabBarTestID: 'tab-home' }} />
      <Tab.Screen
        name="NotificationsTab"
        component={NotificationsStackNavigator}
        options={{
          headerShown: false,
          title: 'Notifications',
          tabBarTestID: 'tab-notifications',
          tabBarBadge: unreadCount > 0 ? unreadCount : undefined,
        }}
      />
      <Tab.Screen
        name="TasksTab"
        component={TasksStackNavigator}
        options={{
          headerShown: false,
          title: 'Tasks',
          tabBarTestID: 'tab-tasks',
          tabBarBadge: activeTaskCount > 0 ? activeTaskCount : undefined,
        }}
      />
      <Tab.Screen name="ProfileTab" component={ProfileStackNavigator} options={{ headerShown: false, title: 'Profile', tabBarTestID: 'tab-profile' }} />
    </Tab.Navigator>
  );
}

const linking = {
  prefixes: ['rndatest://'],
  config: {
    screens: {
      Tabs: {
        screens: {
          HomeTab: {
            screens: {
              HomeMain: 'home',
              Feed: 'feed',
            },
          },
          NotificationsTab: {
            screens: {
              NotificationsMain: 'notifications',
              NotificationDetail: 'notification/:id',
            },
          },
          TasksTab: {
            screens: {
              TasksMain: 'tasks',
              TaskDetail: 'tasks/:id',
            },
          },
          ProfileTab: {
            screens: {
              ProfileMain: 'profile',
              Settings: 'settings',
              ReloadTest: 'reload',
            },
          },
        },
      },
      DeepLink: 'deeplink',
    },
  },
};

export default function RootNavigator() {
  return (
    <RootStack.Navigator>
      <RootStack.Screen name="Tabs" component={TabNavigator} options={{ headerShown: false }} />
      <RootStack.Screen name="ProfileEditModal" component={ProfileEditModal} options={{ presentation: 'modal', headerShown: false }} />
      <RootStack.Screen name="ErrorLab" component={ErrorLabModal} options={{ presentation: 'modal', title: 'Error Lab' }} />
      <RootStack.Screen name="DeepLink" component={DeepLinkScreen} options={{ title: 'Deep Link' }} />
    </RootStack.Navigator>
  );
}

export { linking };
