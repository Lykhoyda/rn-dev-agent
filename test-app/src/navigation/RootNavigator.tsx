import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import type { RootStackParams, TabParams, HomeStackParams, ProfileStackParams } from './types';
import HomeScreen from '../screens/HomeScreen';
import FeedScreen from '../screens/FeedScreen';
import ProfileScreen from '../screens/ProfileScreen';
import SettingsScreen from '../screens/SettingsScreen';
import NotificationsScreen from '../screens/NotificationsScreen';

const RootStack = createNativeStackNavigator<RootStackParams>();
const Tab = createBottomTabNavigator<TabParams>();
const HomeStack = createNativeStackNavigator<HomeStackParams>();
const ProfileStack = createNativeStackNavigator<ProfileStackParams>();

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
    </ProfileStack.Navigator>
  );
}

function TabNavigator() {
  return (
    <Tab.Navigator>
      <Tab.Screen name="HomeTab" component={HomeStackNavigator} options={{ headerShown: false, title: 'Home' }} />
      <Tab.Screen name="NotificationsTab" component={NotificationsScreen} options={{ title: 'Notifications' }} />
      <Tab.Screen name="ProfileTab" component={ProfileStackNavigator} options={{ headerShown: false, title: 'Profile' }} />
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
          NotificationsTab: 'notifications',
          ProfileTab: {
            screens: {
              ProfileMain: 'profile',
              Settings: 'settings',
              ReloadTest: 'reload',
            },
          },
        },
      },
    },
  },
};

export default function RootNavigator() {
  return (
    <RootStack.Navigator>
      <RootStack.Screen name="Tabs" component={TabNavigator} options={{ headerShown: false }} />
    </RootStack.Navigator>
  );
}

export { linking };
