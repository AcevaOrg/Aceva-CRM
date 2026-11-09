"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "@/lib/auth/session";
import { peopleApi } from "./api";
import type { BasicPatch, DocumentKind, JobPatch, OffboardInput, OnboardingInput, PayPatch, PersonalPatch } from "./types";

export const peopleKeys = {
  all: ["people"] as const,
  list: ["people", "list"] as const,
  presence: ["people", "presence"] as const,
  profile: (empId: string, viewer: string | null) => ["people", "profile", empId, viewer] as const,
  offboard: (empId: string) => ["people", "offboard-preview", empId] as const,
};

/** Full staff list for the directory. */
export function usePeople() {
  return useQuery({ queryKey: peopleKeys.list, queryFn: peopleApi.list });
}

/** Who is signed in now: [{ empId, state }] (a dot only, never a metric). */
export function usePresence() {
  return useQuery({ queryKey: peopleKeys.presence, queryFn: peopleApi.presence, refetchInterval: 60_000 });
}

export function useProfile(empId: string) {
  const viewer = useSession((s) => s.empId);
  return useQuery({ queryKey: peopleKeys.profile(empId, viewer), queryFn: () => peopleApi.profile(empId), enabled: !!viewer });
}

export function useOffboardPreview(empId: string, enabled: boolean) {
  return useQuery({ queryKey: peopleKeys.offboard(empId), queryFn: () => peopleApi.offboardPreview(empId), enabled });
}

function useDone() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ["people"] });
    qc.invalidateQueries({ queryKey: ["activity"] });
  };
}

export function useUpdateBasic() {
  const done = useDone();
  return useMutation({ mutationFn: ({ empId, patch, reason }: { empId: string; patch: BasicPatch; reason?: string }) => peopleApi.updateBasic(empId, patch, reason), onSuccess: done });
}

export function useUpdateJob() {
  const done = useDone();
  return useMutation({ mutationFn: ({ empId, patch, reason }: { empId: string; patch: JobPatch; reason: string }) => peopleApi.updateJob(empId, patch, reason), onSuccess: done });
}

export function useUpdatePersonal() {
  const done = useDone();
  return useMutation({ mutationFn: ({ empId, patch }: { empId: string; patch: PersonalPatch }) => peopleApi.updatePersonal(empId, patch), onSuccess: done });
}

export function useUpdatePay() {
  const done = useDone();
  return useMutation({ mutationFn: ({ empId, patch, reason }: { empId: string; patch: PayPatch; reason: string }) => peopleApi.updatePay(empId, patch, reason), onSuccess: done });
}

export function useRevealField() {
  const done = useDone();
  return useMutation({ mutationFn: ({ empId, field }: { empId: string; field: "cnic" | "salary" | "account" }) => peopleApi.reveal(empId, field), onSuccess: done });
}

export function useCreateEmployee() {
  const done = useDone();
  return useMutation({ mutationFn: (input: OnboardingInput) => peopleApi.create(input), onSuccess: done });
}

export function useOffboard() {
  const qc = useQueryClient();
  const done = useDone();
  return useMutation({
    mutationFn: ({ empId, input }: { empId: string; input: OffboardInput }) => peopleApi.offboard(empId, input),
    onSuccess: () => {
      done();
      qc.invalidateQueries({ queryKey: ["tasks"] });
    },
  });
}

export function useUploadDocument() {
  const done = useDone();
  return useMutation({
    mutationFn: ({ empId, file }: { empId: string; file: { kind: DocumentKind; fileName: string; sizeBytes: number } }) => peopleApi.uploadDocument(empId, file),
    onSuccess: done,
  });
}
