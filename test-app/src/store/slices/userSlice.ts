import { createSlice } from '@reduxjs/toolkit';
import type { PayloadAction } from '@reduxjs/toolkit';

interface UserState {
  name: string;
  email: string;
  avatar: string;
  loggedIn: boolean;
}

const initialState: UserState = {
  name: 'Test User',
  email: 'test@rndevagent.com',
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
    setLoggedIn: (state, action: PayloadAction<boolean>) => {
      state.loggedIn = action.payload;
    },
  },
});

export const { updateName, setLoggedIn } = userSlice.actions;
export default userSlice;
