import { createSlice } from '@reduxjs/toolkit';

interface NetworkState {
  isOffline: boolean;
}

const initialState: NetworkState = {
  isOffline: false,
};

const networkSlice = createSlice({
  name: 'network',
  initialState,
  reducers: {
    setOffline: (state) => {
      state.isOffline = true;
    },
    setOnline: (state) => {
      state.isOffline = false;
    },
  },
});

export const { setOffline, setOnline } = networkSlice.actions;

export const selectIsOffline = (state: { network: NetworkState }) => state.network.isOffline;

export default networkSlice;
