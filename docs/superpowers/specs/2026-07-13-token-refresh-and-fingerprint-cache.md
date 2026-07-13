# Token Refresh & Fingerprint Caching Design Spec

**Date:** 2026-07-13
**Ticket ID:** TB-026

## Overview
This document specifies the client-side token refresh interception flow, browser fingerprint caching mechanism, and login loop prevention logic implemented in the TeamBoard web client.

## Core Problems Solved

1. **Stale/Expired Access Tokens causing Auto Logout:**
   - Authenticated API routes returned `401 Unauthorized` responses without a custom `code` field (e.g., `/api/users/me/preferences`), which bypassed the client-side `apiHandler` interceptor.
   - **Solution:** Updated `apiHandler` to trigger silent refresh on any non-auth `401` status code regardless of the custom JSON body payload.

2. **Fingerprint Performance & Instability:**
   - Eagerly loading and evaluating the browser fingerprint (`FingerprintJS.load()`) on every request introduced massive latency and crashes in server-side/middleware-like contexts.
   - **Solution:** Cached the browser fingerprint in-memory (`cachedFingerprint` global variable) and in browser `localStorage` (`tb_fingerprint`) after the first loading cycle.

3. **Login Page Refresh Infinite Loop:**
   - Layout components eagerly requested preferences `/api/users/me/preferences` on the public login page (`/auth/login`), causing a recursive token-refresh redirect loop on unauthenticated sessions.
   - **Solution:** Modified `shouldRefresh` to check if `window.location.pathname` starts with `/auth/` (public auth route) and immediately bypass token refresh.

4. **Task Description Blank Line Spacing (Formatting Rule):**
   - **Crucial Rule:** When creating/editing task descriptions, avoid inserting excessive blank lines or multiple `<br>` tags. Keep blocks separated by standard single newlines or standard paragraph markup.

## Implementation Details

### Client Interceptor (`src/utils/apiHandler.ts`)
- Lazy loads the browser fingerprint only inside the `shouldRefresh` branch when a refresh token request is actually initiated.
- Coalesces concurrent 401s into a single shared `/api/auth/refresh-token` fetch to prevent race conditions or token-reuse warnings on the server.

### Caching (`src/utils/helperFunctions.ts`)
- Resolves fingerprinting via `localStorage.getItem('tb_fingerprint')` if already set; otherwise loads the full FingerprintJS library once and stores the resolved visitor ID.
