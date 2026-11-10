"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isLive } from "@/lib/api/http";
import { useSession } from "@/lib/auth/session";
import { authApi } from "./api";

export const authKeys = {
  all: ["auth"] as const,
  sessions: (empId: string | null) => ["auth", "sessions", empId] as const,
  history: (empId: string | null) => ["auth", "history", empId] as const,
  twoFactor: (empId: string | null) => ["auth", "2fa", empId] as const,
};

/** Where the viewer is signed in right now ("My devices"). */
export function useMySessions() {
  const empId = useSession((s) => s.empId);
  return useQuery({ queryKey: authKeys.sessions(empId), queryFn: authApi.sessions, enabled: !!empId });
}

/** The viewer's own logins and logouts. */
export function useLoginHistory() {
  const empId = useSession((s) => s.empId);
  return useQuery({ queryKey: authKeys.history(empId), queryFn: authApi.loginHistory, enabled: !!empId });
}

export function useTwoFactorStatus() {
  const empId = useSession((s) => s.empId);
  return useQuery({ queryKey: authKeys.twoFactor(empId), queryFn: authApi.twoFactorStatus, enabled: !!empId });
}

export function useSetTwoFactor() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (enabled: boolean) => authApi.setTwoFactor(enabled), onSuccess: () => qc.invalidateQueries({ queryKey: ["auth"] }) });
}

/** Ends one other session, or every other session when no id is given. */
export function useEndSession() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id?: string) => authApi.endSession(id), onSuccess: () => qc.invalidateQueries({ queryKey: ["auth"] }) });
}

export function useChangePassword() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ newPassword, currentPassword }: { newPassword: string; currentPassword?: string }) => {
      await authApi.changePassword(newPassword, currentPassword);
      // A password change ends the session on every other device (plan §6). The real server does this itself.
      if (!isLive("m2")) await authApi.endSession();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["auth"] }),
  });
}
