import { createSlice } from '@reduxjs/toolkit';
import type { PayloadAction } from '@reduxjs/toolkit';

interface UserState {
  name: string;
  email: string;
  bio: string;
  website: string;
  company: string;
  avatar: string;
  loggedIn: boolean;
}

const initialState: UserState = {
  name: 'Test User',
  email: 'test@rndevagent.com',
  bio: '',
  website: '',
  company: '',
  avatar: 'https://placeholders.dev/40x40',
  loggedIn: true,
};

const userSlice = createSlice({
  name: 'user',
  initialState,
  reducers: {
    updateName: (state, action: PayloadAction<string>) => {
      state.name = action.payload;
    },
    updateProfile: (state, action: PayloadAction<{ name: string; email: string; bio: string; website: string; company: string }>) => {
      state.name = action.payload.name;
      state.email = action.payload.email;
      state.bio = action.payload.bio;
      state.website = action.payload.website;
      state.company = action.payload.company;
    },
    setLoggedIn: (state, action: PayloadAction<boolean>) => {
      state.loggedIn = action.payload;
    },
  },
});

export const { updateName, updateProfile, setLoggedIn } = userSlice.actions;
export default userSlice;
