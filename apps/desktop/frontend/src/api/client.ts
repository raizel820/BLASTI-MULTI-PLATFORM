/**
 * Desktop API Client
 *
 * This client ONLY communicates with the local API server at localhost:3080.
 * It never calls the cloud API directly. The local API syncs with the cloud
 * in the background when online.
 *
 * Architecture:
 *   Desktop Frontend → localhost:3080/api/* → Local Hono API → SQLite
 *                                                   ↕
 *                                             Sync Service → Cloud API (when online)
 *
 * When served by the local API (production), same-origin requests are used.
 * When running on the Vite dev server (port 5173), relative URLs are used
 * so the Vite proxy can forward requests to the local API on port 3080.
 */

// Use relative URLs when running on the Vite dev server (so the proxy works),
// or absolute URLs when served by the local API (same-origin).
const isDevServer = typeof window !== 'undefined' &&
  (window.location.port === '5173' || window.location.port === '3000');
const LOCAL_API_BASE = isDevServer ? '' : 'http://127.0.0.1:3080';

interface RequestOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  params?: Record<string, string>;
}

interface ApiResponse<T = any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  success: boolean;
  data?: T;
  error?: string;
  [key: string]: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

class ApiClient {
  private baseUrl: string;
  private token: string | null = null;

  constructor(baseUrl: string = LOCAL_API_BASE) {
    this.baseUrl = baseUrl;
    // Restore token from localStorage
    this.token = localStorage.getItem('blasti-local-api-token');
  }

  setToken(token: string | null) {
    this.token = token;
    if (token) {
      localStorage.setItem('blasti-local-api-token', token);
    } else {
      localStorage.removeItem('blasti-local-api-token');
    }
  }

  getToken(): string | null {
    return this.token;
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    return headers;
  }

  private buildUrl(path: string, params?: Record<string, string>): string {
    const url = new URL(`${this.baseUrl}${path}`);
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          url.searchParams.set(key, value);
        }
      });
    }
    return url.toString();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async request<T = any>(path: string, options: RequestOptions = {}): Promise<T> {
    const { method = 'GET', body, headers: extraHeaders, params } = options;

    const url = this.buildUrl(path, params);
    const headers = { ...this.buildHeaders(), ...extraHeaders };

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (response.status === 401) {
      // Try to distinguish between offline session expiry and auth failure
      try {
        const errorBody = await response.clone().json();
        if (errorBody.code === 'OFFLINE_SESSION_EXPIRED') {
          // Offline too long — show reconnect prompt instead of hard redirect
          this.setToken(null);
          // Dispatch a custom event so the UI can show a reconnect dialog
          window.dispatchEvent(new CustomEvent('blasti:offline-expired', {
            detail: { offlineDays: errorBody.offlineDays, message: errorBody.error }
          }));
          throw new Error(errorBody.error || 'Offline session expired');
        }
      } catch (parseErr) {
        // If we can't parse the body, fall through to default handling
        if (parseErr instanceof Error && parseErr.message.includes('Offline session expired')) {
          throw parseErr;
        }
      }
      // Standard auth failure - redirect to login
      this.setToken(null);
      window.location.href = '/login';
      throw new Error('Session expired');
    }

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(errorData.error || `Request failed with status ${response.status}`);
    }

    return response.json();
  }

  // ─── Auth ──────────────────────────────────────────────────────
  async login(username: string, password: string) {
    const res = await this.request('/api/auth/login', {
      method: 'POST',
      body: { username, password },
    });
    // The local API returns: { success: true, user: {...}, token: "...", source: "cloud"|"offline" }
    const result = res as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (result.success && result.token) {
      this.setToken(result.token);
      return { token: result.token, user: result.user, source: result.source, offlineWarning: result.offlineWarning };
    }
    throw new Error(result.error || 'Login failed');
  }

  async forgotPassword(username: string) {
    return this.request('/api/auth/forgot-password', {
      method: 'POST',
      body: { username },
    });
  }

  async resetPassword(token: string, newPassword: string) {
    return this.request('/api/auth/reset-password', {
      method: 'POST',
      body: { token, newPassword },
    });
  }

  async checkUsername(username: string) {
    return this.request(`/api/auth/check-username?username=${encodeURIComponent(username)}`);
  }

  // ─── Agency ────────────────────────────────────────────────────
  async getAgency() {
    return this.request('/api/agency');
  }

  async updateProfile(data: Record<string, unknown>) {
    return this.request('/api/agency/profile', { method: 'PATCH', body: data });
  }

  async getSettings() {
    return this.request('/api/agency/settings');
  }

  async updateSettings(data: Record<string, unknown>) {
    return this.request('/api/agency/settings', { method: 'PATCH', body: data });
  }

  async getWorkingHours() {
    return this.request('/api/agency/working-hours');
  }

  async updateWorkingHours(data: { workingHoursStart?: string; workingHoursEnd?: string }) {
    return this.request('/api/agency/working-hours', { method: 'PATCH', body: data });
  }

  async getSubscription() {
    return this.request('/api/agency/subscription');
  }

  async getSubscriptionPlans() {
    return this.request('/api/agency/subscription-plans');
  }

  async getDailyChart() {
    return this.request('/api/agency/daily-chart');
  }

  // ─── Services ──────────────────────────────────────────────────
  async getServices() {
    return this.request('/api/services');
  }

  async createService(data: Record<string, unknown>) {
    return this.request('/api/services', { method: 'POST', body: data });
  }

  async updateService(id: string, data: Record<string, unknown>) {
    return this.request(`/api/services/${id}`, { method: 'PATCH', body: data });
  }

  async deleteService(id: string) {
    return this.request(`/api/services/${id}`, { method: 'DELETE' });
  }

  // ─── Branches ──────────────────────────────────────────────────
  async getBranches() {
    return this.request('/api/agency/branches');
  }

  async getBranch(id: string) {
    return this.request(`/api/agency/branches/${id}`);
  }

  async createBranch(data: Record<string, unknown>) {
    return this.request('/api/agency/branches', { method: 'POST', body: data });
  }

  async updateBranch(id: string, data: Record<string, unknown>) {
    return this.request(`/api/agency/branches/${id}`, { method: 'PATCH', body: data });
  }

  async deleteBranch(id: string) {
    return this.request(`/api/agency/branches/${id}`, { method: 'DELETE' });
  }

  // ─── Counters ──────────────────────────────────────────────────
  async createCounter(branchId: string, data: Record<string, unknown>) {
    return this.request(`/api/agency/branches/${branchId}/counters`, { method: 'POST', body: data });
  }

  async updateCounter(branchId: string, counterId: string, data: Record<string, unknown>) {
    return this.request(`/api/agency/branches/${branchId}/counters/${counterId}`, { method: 'PATCH', body: data });
  }

  // ─── Staff ─────────────────────────────────────────────────────
  async getStaff() {
    return this.request('/api/agency/staff');
  }

  async addStaff(data: Record<string, unknown>) {
    return this.request('/api/agency/staff', { method: 'POST', body: data });
  }

  async updateStaff(id: string, data: Record<string, unknown>) {
    return this.request(`/api/agency/staff/${id}`, { method: 'PATCH', body: data });
  }

  async removeStaff(staffId: string) {
    return this.request('/api/agency/staff', { method: 'DELETE', params: { staffId } });
  }

  // ─── Queue / Reservations ──────────────────────────────────────
  async getQueue() {
    return this.request('/api/queue');
  }

  async getQueueStatus() {
    return this.request('/api/queue/status');
  }

  async callNext(serviceId?: string) {
    return this.request('/api/queue/call-next', { method: 'POST', body: { serviceId } });
  }

  async callReservation(id: string) {
    return this.request(`/api/reservations/${id}/call`, { method: 'POST' });
  }

  async completeReservation(id: string) {
    return this.request(`/api/reservations/${id}/complete`, { method: 'POST' });
  }

  async noShowReservation(id: string) {
    return this.request(`/api/reservations/${id}/noshow`, { method: 'POST' });
  }

  async cancelReservation(id: string) {
    return this.request(`/api/reservations/${id}/cancel`, { method: 'POST' });
  }

  async recallReservation(id: string) {
    return this.request(`/api/reservations/${id}/recall`, { method: 'POST' });
  }

  async postponeReservation(id: string) {
    return this.request(`/api/reservations/${id}/postpone`, { method: 'POST' });
  }

  async joinQueue(data: Record<string, unknown>) {
    return this.request('/api/reservations', { method: 'POST', body: data });
  }

  // ─── Stats ─────────────────────────────────────────────────────
  async getStats() {
    return this.request('/api/stats/daily');
  }

  async getServiceBreakdown() {
    return this.request('/api/stats/service-breakdown');
  }

  async getWaitTimes() {
    return this.request('/api/stats/wait-times');
  }

  async getNoShowAnalytics() {
    return this.request('/api/stats/no-show');
  }

  async getPeakHours() {
    return this.request('/api/stats/peak-hours');
  }

  // ─── History ───────────────────────────────────────────────────
  async getHistory(params?: { skip?: number; take?: number; status?: string }) {
    return this.request('/api/reservations/history', { params: params as Record<string, string> });
  }

  // ─── Reviews ───────────────────────────────────────────────────
  async getReviews(params?: { skip?: number; take?: number }) {
    return this.request('/api/agency/reviews', { params: params as Record<string, string> });
  }

  async createReview(data: Record<string, unknown>) {
    return this.request('/api/agency/reviews', { method: 'POST', body: data });
  }

  async deleteReview(reviewId: string) {
    return this.request('/api/agency/reviews', { method: 'DELETE', body: { reviewId } });
  }

  // ─── Notifications ─────────────────────────────────────────────
  async getNotifications(params?: { skip?: number; take?: number }) {
    return this.request('/api/notifications', { params: params as Record<string, string> });
  }

  async markNotificationRead(id: string) {
    return this.request(`/api/notifications/${id}/read`, { method: 'POST' });
  }

  // ─── Announcements ─────────────────────────────────────────────
  async getAnnouncements() {
    return this.request('/api/agency/announcements');
  }

  async createAnnouncement(data: Record<string, unknown>) {
    return this.request('/api/agency/announcements', { method: 'POST', body: data });
  }

  async deleteAnnouncement(id: string) {
    return this.request(`/api/agency/announcements/${id}`, { method: 'DELETE' });
  }

  // ─── User Profile ──────────────────────────────────────────────
  async getUserProfile() {
    return this.request('/api/user/profile');
  }

  async updateUserProfile(data: Record<string, unknown>) {
    return this.request('/api/user/profile', { method: 'PATCH', body: data });
  }

  async changePassword(currentPassword: string, newPassword: string) {
    return this.request('/api/user/change-password', { method: 'PATCH', body: { currentPassword, newPassword } });
  }

  async getUserPreferences() {
    return this.request('/api/user/preferences');
  }

  async updateUserPreferences(data: Record<string, unknown>) {
    return this.request('/api/user/preferences', { method: 'PATCH', body: data });
  }

  // ─── Queue Advanced ───────────────────────────────────────────
  async pauseQueue() {
    return this.request('/api/queue/pause', { method: 'POST' });
  }

  async resumeQueue() {
    return this.request('/api/queue/resume', { method: 'POST' });
  }

  async toggleQueuePause() {
    return this.request('/api/agency/queue/toggle-pause', { method: 'POST' });
  }

  async walkIn(data: Record<string, unknown>) {
    return this.request('/api/agency/queue/walk-in', { method: 'POST', body: data });
  }

  async getActiveQueue() {
    return this.request('/api/queue/active');
  }

  async getTodayQueue() {
    return this.request('/api/queue/today');
  }

  // ─── Reviews Advanced ─────────────────────────────────────────
  async replyToReview(id: string, reply: string) {
    return this.request(`/api/reviews/${id}/reply`, { method: 'POST', body: { reply } });
  }

  // ─── Agency Advanced ──────────────────────────────────────────
  async getAgencyActivity() {
    return this.request('/api/agency/activity');
  }

  async getAnalytics() {
    return this.request('/api/agency/analytics');
  }

  async getHistoryDetail(id: string) {
    return this.request(`/api/agency/history/${id}`);
  }

  async exportCSV(params?: Record<string, string>) {
    return this.request('/api/agency/export-csv', { params });
  }

  async getQrCode() {
    return this.request('/api/agency/qr-code');
  }

  // ─── Favorites ────────────────────────────────────────────────
  async getFavorites() {
    return this.request('/api/agency/favorites');
  }

  async addFavorite(data: Record<string, unknown>) {
    return this.request('/api/agency/favorites', { method: 'POST', body: data });
  }

  async removeFavorite(id: string) {
    return this.request('/api/agency/favorites', { method: 'DELETE', params: { id } });
  }

  // ─── FAQs ─────────────────────────────────────────────────────
  async getFaqs() {
    return this.request('/api/agency/faqs');
  }

  async createFaq(data: Record<string, unknown>) {
    return this.request('/api/agency/faqs', { method: 'POST', body: data });
  }

  async updateFaq(id: string, data: Record<string, unknown>) {
    return this.request(`/api/agency/faqs/${id}`, { method: 'PATCH', body: data });
  }

  async deleteFaq(id: string) {
    return this.request(`/api/agency/faqs/${id}`, { method: 'DELETE' });
  }

  // ─── Transactions ─────────────────────────────────────────────
  async getTransactions(params?: { skip?: number; take?: number }) {
    return this.request('/api/agency/transactions', { params: params as Record<string, string> });
  }

  // ─── Sync ──────────────────────────────────────────────────────
  async getSyncStatus() {
    return this.request('/api/sync/status');
  }

  async triggerSync() {
    return this.request('/api/sync/trigger', { method: 'POST' });
  }

  // ─── Initial Sync ─────────────────────────────────────────────
  async getInitialSyncStatus() {
    return this.request('/api/sync/initial-status');
  }

  async startInitialSync(agencyId: string, cloudAuthToken: string) {
    return this.request('/api/sync/initial-sync', {
      method: 'POST',
      body: { agencyId, cloudAuthToken },
    });
  }

  async abortInitialSync() {
    return this.request('/api/sync/initial-sync/abort', { method: 'POST' });
  }

  async resetInitialSync() {
    return this.request('/api/sync/initial-sync/reset', { method: 'POST' });
  }

  // ─── Health ────────────────────────────────────────────────────
  async healthCheck() {
    return this.request('/api/health');
  }

  async getDbStatus() {
    return this.request('/api/db-status');
  }
}

// Singleton instance
export const api = new ApiClient();
export default api;
