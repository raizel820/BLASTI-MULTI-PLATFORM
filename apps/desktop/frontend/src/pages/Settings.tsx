import { useCallback, useState, useEffect } from 'react';
import { Save, Loader2, Bell, Clock, Settings2 } from 'lucide-react';
import api from '@/api/client';
import { useApi } from '@/hooks/use-api';

export default function SettingsPage() {
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  const fetchAgency = useCallback(() => api.getAgency(), []);
  const { data: agencyData, isLoading } = useApi(fetchAgency);

  const fetchSettings = useCallback(() => api.getSettings(), []);
  const { data: settingsData } = useApi(fetchSettings);

  const fetchWorkingHours = useCallback(() => api.getWorkingHours(), []);
  const { data: whData } = useApi(fetchWorkingHours);

  const fetchPrefs = useCallback(() => api.getUserPreferences(), []);
  const { data: prefsData } = useApi(fetchPrefs);

  const agency = (agencyData?.agency || agencyData?.data || agencyData || {}) as Record<string, unknown>;
  const settings = (settingsData?.settings || settingsData?.data || settingsData || {}) as Record<string, unknown>;
  const workingHours = (whData?.workingHours || whData?.data || whData || {}) as Record<string, unknown>;
  const prefs = (prefsData?.preferences || prefsData?.data || prefsData || {}) as Record<string, unknown>;

  const [profile, setProfile] = useState({
    name: '', email: '', phone: '', address: '',
    workingHoursStart: '08:00', workingHoursEnd: '17:00',
    averageServiceTime: 15, maxActiveReservations: 50,
    isQueueOpen: true, autoPauseWhenFull: false,
    kioskModeEnabled: false, maxQueueSize: 100,
  });

  const [notifications, setNotifications] = useState({
    emailOnNewReservation: true, emailOnNoShow: false,
    smsOnCalled: true, pushOnCalled: true,
    digestEnabled: true, digestFrequency: 'daily',
  });

  useEffect(() => {
    setProfile({
      name: (agency.name as string) || '',
      email: (agency.email as string) || '',
      phone: (agency.phone as string) || '',
      address: (agency.address as string) || '',
      workingHoursStart: (workingHours.workingHoursStart as string) || (agency.workingHoursStart as string) || (settings.workingHoursStart as string) || '08:00',
      workingHoursEnd: (workingHours.workingHoursEnd as string) || (agency.workingHoursEnd as string) || (settings.workingHoursEnd as string) || '17:00',
      averageServiceTime: (agency.averageServiceTime as number) || (settings.averageServiceTime as number) || 15,
      maxActiveReservations: (agency.maxActiveReservations as number) || (settings.maxActiveReservations as number) || 50,
      isQueueOpen: (agency.isQueueOpen as boolean) ?? (settings.isQueueOpen as boolean) ?? true,
      autoPauseWhenFull: (agency.autoPauseWhenFull as boolean) ?? (settings.autoPauseWhenFull as boolean) ?? false,
      kioskModeEnabled: (agency.kioskModeEnabled as boolean) ?? (settings.kioskModeEnabled as boolean) ?? false,
      maxQueueSize: (agency.maxQueueSize as number) || (settings.maxQueueSize as number) || 100,
    });
  }, [agency, settings, workingHours]);

  useEffect(() => {
    setNotifications({
      emailOnNewReservation: (prefs.emailOnNewReservation as boolean) ?? true,
      emailOnNoShow: (prefs.emailOnNoShow as boolean) ?? false,
      smsOnCalled: (prefs.smsOnCalled as boolean) ?? true,
      pushOnCalled: (prefs.pushOnCalled as boolean) ?? true,
      digestEnabled: (prefs.digestEnabled as boolean) ?? true,
      digestFrequency: (prefs.digestFrequency as string) || 'daily',
    });
  }, [prefs]);

  const handleSave = async () => {
    setSaving(true);
    setMessage('');
    try {
      await api.updateProfile({
        name: profile.name, email: profile.email, phone: profile.phone, address: profile.address,
      });
      await api.updateSettings({
        averageServiceTime: profile.averageServiceTime,
        maxActiveReservations: profile.maxActiveReservations,
        maxQueueSize: profile.maxQueueSize,
        isQueueOpen: profile.isQueueOpen,
        autoPauseWhenFull: profile.autoPauseWhenFull,
        kioskModeEnabled: profile.kioskModeEnabled,
      });
      await api.updateWorkingHours({
        workingHoursStart: profile.workingHoursStart,
        workingHoursEnd: profile.workingHoursEnd,
      });
      await api.updateUserPreferences({
        emailOnNewReservation: notifications.emailOnNewReservation,
        emailOnNoShow: notifications.emailOnNoShow,
        smsOnCalled: notifications.smsOnCalled,
        pushOnCalled: notifications.pushOnCalled,
        digestEnabled: notifications.digestEnabled,
        digestFrequency: notifications.digestFrequency,
      });
      setMessage('Settings saved successfully');
      setTimeout(() => setMessage(''), 3000);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const inputClass = "w-full px-3 py-2 rounded-lg border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring text-sm";

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Settings</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Configure your agency</p>
        </div>
        <button onClick={handleSave} disabled={saving}
          className="px-4 py-2 rounded-lg bg-emerald-500 text-white text-sm font-medium hover:bg-emerald-600 disabled:opacity-50 transition-all flex items-center gap-2">
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          Save Changes
        </button>
      </div>

      {message && (
        <div className={`text-sm rounded-lg px-4 py-3 ${message.includes('success') ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}`}>
          {message}
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center py-12 text-muted-foreground">
          <Loader2 className="w-5 h-5 animate-spin" />
        </div>
      ) : (
        <>
          {/* Profile */}
          <div className="rounded-xl border border-border bg-card p-5 space-y-4">
            <h2 className="text-sm font-semibold text-foreground">Agency Profile</h2>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">Name</label>
                <input value={profile.name} onChange={(e) => setProfile({ ...profile, name: e.target.value })} className={inputClass} />
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">Email</label>
                <input type="email" value={profile.email} onChange={(e) => setProfile({ ...profile, email: e.target.value })} className={inputClass} />
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">Phone</label>
                <input value={profile.phone} onChange={(e) => setProfile({ ...profile, phone: e.target.value })} className={inputClass} />
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">Address</label>
                <input value={profile.address} onChange={(e) => setProfile({ ...profile, address: e.target.value })} className={inputClass} />
              </div>
            </div>
          </div>

          {/* Working Hours */}
          <div className="rounded-xl border border-border bg-card p-5 space-y-4">
            <div className="flex items-center gap-2">
              <Clock className="w-4 h-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold text-foreground">Working Hours</h2>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">Start Time</label>
                <input type="time" value={profile.workingHoursStart} onChange={(e) => setProfile({ ...profile, workingHoursStart: e.target.value })} className={inputClass} />
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">End Time</label>
                <input type="time" value={profile.workingHoursEnd} onChange={(e) => setProfile({ ...profile, workingHoursEnd: e.target.value })} className={inputClass} />
              </div>
            </div>
          </div>

          {/* Queue Settings */}
          <div className="rounded-xl border border-border bg-card p-5 space-y-4">
            <div className="flex items-center gap-2">
              <Settings2 className="w-4 h-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold text-foreground">Queue Settings</h2>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">Avg Service Time (min)</label>
                <input type="number" value={profile.averageServiceTime} onChange={(e) => setProfile({ ...profile, averageServiceTime: parseInt(e.target.value) || 15 })} className={inputClass} />
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">Max Queue Size</label>
                <input type="number" value={profile.maxQueueSize} onChange={(e) => setProfile({ ...profile, maxQueueSize: parseInt(e.target.value) || 100 })} className={inputClass} />
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">Max Active Reservations</label>
                <input type="number" value={profile.maxActiveReservations} onChange={(e) => setProfile({ ...profile, maxActiveReservations: parseInt(e.target.value) || 50 })} className={inputClass} />
              </div>
            </div>
            <div className="space-y-3 pt-2">
              <label className="flex items-center gap-3 text-sm text-foreground">
                <input type="checkbox" checked={profile.isQueueOpen} onChange={(e) => setProfile({ ...profile, isQueueOpen: e.target.checked })} className="rounded border-border" />
                Queue is open
              </label>
              <label className="flex items-center gap-3 text-sm text-foreground">
                <input type="checkbox" checked={profile.autoPauseWhenFull} onChange={(e) => setProfile({ ...profile, autoPauseWhenFull: e.target.checked })} className="rounded border-border" />
                Auto-pause when queue is full
              </label>
              <label className="flex items-center gap-3 text-sm text-foreground">
                <input type="checkbox" checked={profile.kioskModeEnabled} onChange={(e) => setProfile({ ...profile, kioskModeEnabled: e.target.checked })} className="rounded border-border" />
                Kiosk mode enabled
              </label>
            </div>
          </div>

          {/* Notification Preferences */}
          <div className="rounded-xl border border-border bg-card p-5 space-y-4">
            <div className="flex items-center gap-2">
              <Bell className="w-4 h-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold text-foreground">Notification Preferences</h2>
            </div>
            <div className="space-y-3">
              <label className="flex items-center gap-3 text-sm text-foreground">
                <input type="checkbox" checked={notifications.emailOnNewReservation} onChange={(e) => setNotifications({ ...notifications, emailOnNewReservation: e.target.checked })} className="rounded border-border" />
                Email on new reservation
              </label>
              <label className="flex items-center gap-3 text-sm text-foreground">
                <input type="checkbox" checked={notifications.emailOnNoShow} onChange={(e) => setNotifications({ ...notifications, emailOnNoShow: e.target.checked })} className="rounded border-border" />
                Email on no-show
              </label>
              <label className="flex items-center gap-3 text-sm text-foreground">
                <input type="checkbox" checked={notifications.smsOnCalled} onChange={(e) => setNotifications({ ...notifications, smsOnCalled: e.target.checked })} className="rounded border-border" />
                SMS when customer is called
              </label>
              <label className="flex items-center gap-3 text-sm text-foreground">
                <input type="checkbox" checked={notifications.pushOnCalled} onChange={(e) => setNotifications({ ...notifications, pushOnCalled: e.target.checked })} className="rounded border-border" />
                Push notification when called
              </label>
              <div className="pt-2 border-t border-border">
                <label className="flex items-center gap-3 text-sm text-foreground">
                  <input type="checkbox" checked={notifications.digestEnabled} onChange={(e) => setNotifications({ ...notifications, digestEnabled: e.target.checked })} className="rounded border-border" />
                  Email digest
                </label>
                {notifications.digestEnabled && (
                  <div className="mt-2 ml-6">
                    <select
                      value={notifications.digestFrequency}
                      onChange={(e) => setNotifications({ ...notifications, digestFrequency: e.target.value })}
                      className="w-full max-w-xs px-3 py-2 rounded-lg border border-border bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring text-sm"
                    >
                      <option value="daily">Daily</option>
                      <option value="weekly">Weekly</option>
                      <option value="monthly">Monthly</option>
                    </select>
                  </div>
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
