"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api-client";
import type { User } from "@/lib/types";

// One /auth/status request per page load, shared by every component that asks.
let pending: Promise<User | null> | null = null;

function loadCurrentUser(): Promise<User | null> {
  pending ??= api.auth
    .status()
    .then((status) => status.user)
    .catch(() => {
      pending = null; // Retry on the next mount instead of caching a failure.
      return null;
    });
  return pending;
}

/**
 * The signed-in account. `user` is null while loading (`loading` true) or when the status request
 * failed. `isAdmin` is false until the account is known, so admin-only UI stays hidden meanwhile.
 */
export function useCurrentUser(): { user: User | null; loading: boolean; isAdmin: boolean } {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void loadCurrentUser().then((value) => {
      if (cancelled) return;
      setUser(value);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return { user, loading, isAdmin: user?.role === "admin" };
}
