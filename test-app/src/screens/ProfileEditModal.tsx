import React from 'react';
import { KeyboardAvoidingView, Platform, View, Text, TextInput, Pressable, ScrollView } from 'react-native';
import { useSelector, useDispatch } from 'react-redux';
import { useForm, Controller, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootState, AppDispatch } from '../store';
import type { RootStackParams } from '../navigation/types';
import { updateProfile } from '../store/slices/userSlice';
import { useThemeColors } from '../hooks/useThemeColors';

const profileSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters').max(50, 'Name must be at most 50 characters'),
  email: z.string().email('Enter a valid email address'),
  bio: z.string().max(200, 'Bio must be at most 200 characters').optional().default(''),
  website: z.string().url('Enter a valid URL').or(z.literal('')).optional().default(''),
  company: z.string().optional().default(''),
});

type ProfileFormData = z.infer<typeof profileSchema>;

type Props = NativeStackScreenProps<RootStackParams, 'ProfileEditModal'>;

const BASE_URL = 'https://api.testapp.local';

export default function ProfileEditModal({ navigation }: Props) {
  const user = useSelector((state: RootState) => state.user);
  const dispatch = useDispatch<AppDispatch>();
  const colors = useThemeColors();

  const { control, handleSubmit, formState: { errors, isValid, isDirty } } = useForm<ProfileFormData>({
    resolver: zodResolver(profileSchema),
    mode: 'onChange',
    defaultValues: {
      name: user.name,
      email: user.email,
      bio: user.bio ?? '',
      website: user.website ?? '',
      company: user.company ?? '',
    },
  });

  const bioValue = useWatch({ control, name: 'bio' });
  const nameValue = useWatch({ control, name: 'name' });
  const showCompany = /\b(work|job)\b/i.test(bioValue ?? '');

  const onSubmit = (data: ProfileFormData) => {
    dispatch(updateProfile({
      name: data.name.trim(),
      email: data.email.trim(),
      bio: data.bio ?? '',
      website: data.website ?? '',
      company: data.company ?? '',
    }));

    fetch(`${BASE_URL}/api/user/profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }).catch(() => {});

    navigation.goBack();
  };

  return (
    <KeyboardAvoidingView
      className={`flex-1 ${colors.bg}`}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView className="flex-1 px-4 pt-14" keyboardShouldPersistTaps="handled">
        <View className="flex-row items-center justify-between">
          <Pressable onPress={() => navigation.goBack()} className="p-2">
            <Text className={`text-base ${colors.text}`}>Cancel</Text>
          </Pressable>
          <Text className={`text-lg font-semibold ${colors.text}`}>Edit Profile</Text>
          <Pressable
            testID="rhf-save-btn"
            onPress={handleSubmit(onSubmit)}
            disabled={!isValid || !isDirty}
            className={`rounded-lg px-4 py-2 ${isValid && isDirty ? 'bg-blue-500' : 'bg-gray-300'}`}
          >
            <Text className={`font-semibold ${isValid && isDirty ? 'text-white' : 'text-gray-500'}`}>Save</Text>
          </Pressable>
        </View>

        {/* Name */}
        <View className="mt-6">
          <View className="flex-row items-center justify-between">
            <Text className={`mb-1 text-sm font-medium ${colors.text}`}>Name *</Text>
            <Text testID="rhf-char-count-name" className={`text-xs ${colors.muted}`}>{(nameValue ?? '').length}/50</Text>
          </View>
          <Controller
            control={control}
            name="name"
            render={({ field: { onChange, onBlur, value } }) => (
              <TextInput
                testID="rhf-name"
                className={`rounded-lg border ${errors.name ? 'border-red-500' : colors.border} px-3 py-2 text-base ${colors.text}`}
                placeholderTextColor={colors.placeholderColor}
                placeholder="Your name"
                value={value}
                onChangeText={onChange}
                onBlur={onBlur}
                autoCapitalize="words"
              />
            )}
          />
          {errors.name && (
            <Text testID="rhf-error-name" className="mt-1 text-sm text-red-500">{errors.name.message}</Text>
          )}
        </View>

        {/* Email */}
        <View className="mt-4">
          <Text className={`mb-1 text-sm font-medium ${colors.text}`}>Email *</Text>
          <Controller
            control={control}
            name="email"
            render={({ field: { onChange, onBlur, value } }) => (
              <TextInput
                testID="rhf-email"
                className={`rounded-lg border ${errors.email ? 'border-red-500' : colors.border} px-3 py-2 text-base ${colors.text}`}
                placeholderTextColor={colors.placeholderColor}
                placeholder="you@example.com"
                value={value}
                onChangeText={onChange}
                onBlur={onBlur}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
              />
            )}
          />
          {errors.email && (
            <Text testID="rhf-error-email" className="mt-1 text-sm text-red-500">{errors.email.message}</Text>
          )}
        </View>

        {/* Bio */}
        <View className="mt-4">
          <View className="flex-row items-center justify-between">
            <Text className={`mb-1 text-sm font-medium ${colors.text}`}>Bio</Text>
            <Text testID="rhf-char-count-bio" className={`text-xs ${colors.muted}`}>{(bioValue ?? '').length}/200</Text>
          </View>
          <Controller
            control={control}
            name="bio"
            render={({ field: { onChange, onBlur, value } }) => (
              <TextInput
                testID="rhf-bio"
                className={`rounded-lg border ${errors.bio ? 'border-red-500' : colors.border} px-3 py-2 text-base ${colors.text}`}
                placeholderTextColor={colors.placeholderColor}
                placeholder="Tell us about yourself"
                value={value}
                onChangeText={onChange}
                onBlur={onBlur}
                multiline
                numberOfLines={3}
                textAlignVertical="top"
                style={{ minHeight: 80 }}
              />
            )}
          />
          {errors.bio && (
            <Text testID="rhf-error-bio" className="mt-1 text-sm text-red-500">{errors.bio.message}</Text>
          )}
        </View>

        {/* Conditional Company */}
        {showCompany && (
          <View className="mt-4">
            <Text className={`mb-1 text-sm font-medium ${colors.text}`}>Company</Text>
            <Controller
              control={control}
              name="company"
              render={({ field: { onChange, onBlur, value } }) => (
                <TextInput
                  testID="rhf-company"
                  className={`rounded-lg border ${colors.border} px-3 py-2 text-base ${colors.text}`}
                  placeholderTextColor={colors.placeholderColor}
                  placeholder="Where do you work?"
                  value={value}
                  onChangeText={onChange}
                  onBlur={onBlur}
                />
              )}
            />
          </View>
        )}

        {/* Website */}
        <View className="mt-4">
          <Text className={`mb-1 text-sm font-medium ${colors.text}`}>Website</Text>
          <Controller
            control={control}
            name="website"
            render={({ field: { onChange, onBlur, value } }) => (
              <TextInput
                testID="rhf-website"
                className={`rounded-lg border ${errors.website ? 'border-red-500' : colors.border} px-3 py-2 text-base ${colors.text}`}
                placeholderTextColor={colors.placeholderColor}
                placeholder="https://example.com"
                value={value}
                onChangeText={onChange}
                onBlur={onBlur}
                keyboardType="url"
                autoCapitalize="none"
                autoCorrect={false}
              />
            )}
          />
          {errors.website && (
            <Text testID="rhf-error-website" className="mt-1 text-sm text-red-500">{errors.website.message}</Text>
          )}
        </View>

        <View className="h-20" />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
