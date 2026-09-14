/**
 * Token 状态 store。
 */
import { create } from 'zustand';
import { apiGet } from '@/services/api';

export interface TokenOverview {
  systemPool: number;
  totalTaxCollected: number;
  totalDestroyed: number;
  currentTaxRate: number;
  walletCount: number;
}

export interface TokenTransaction {
  transactionId: string;
  walletId: string;
  traceId: string;
  type: string;
  amount: number;
  balanceAfter: number;
  description: string;
  createdAt: number;
}

interface TokenState {
  overview: TokenOverview | null;
  transactions: TokenTransaction[];
  loading: boolean;
  hydrate: () => Promise<void>;
  hydrateTransactions: () => Promise<void>;
  applyEvent: (type: string) => void;
}

export const useTokenStore = create<TokenState>((set) => ({
  overview: null,
  transactions: [],
  loading: false,

  hydrate: async () => {
    set({ loading: true });
    const res = await apiGet<TokenOverview>('/api/tokens/overview');
    if (res.ok) set({ overview: res.data, loading: false });
    else set({ loading: false });
  },

  hydrateTransactions: async () => {
    const res = await apiGet<TokenTransaction[]>('/api/tokens/transactions');
    if (res.ok) set({ transactions: res.data });
  },

  applyEvent: (type) => {
    if (type.startsWith('token:')) {
      useTokenStore.getState().hydrate();
    }
  },
}));
