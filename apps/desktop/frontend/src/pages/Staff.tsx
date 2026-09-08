import { useCallback, useState } from 'react';
import { Plus, Pencil, Trash2, User, Loader2, Shield, MapPin } from 'lucide-react';
import api from '@/api/client';
import { useApi } from '@/hooks/use-api';

interface StaffMember {
  id: string;
  fullName?: string;
  username?: string;
  email?: string;
  role?: string;
  isActive?: boolean;
  createdAt?: string;
  branchId?: string;
  branchName?: string;
  canManageQueue?: boolean;
  canManageServices?: boolean;
  canManageStaff?: boolean;
  canManageBranches?: boolean;
  canViewAnalytics?: boolean;
  canManageSettings?: boolean;
}

const PERMISSION_FLAGS = [
  { key: 'canManageQueue', label: 'Manage Queue' },
  { key: 'canManageServices', label: 'Manage Services' },
  { key: 'canManageStaff', label: 'Manage Staff' },
  { key: 'canManageBranches', label: 'Manage Branches' },
  { key: 'canViewAnalytics', label: 'View Analytics' },
  { key: 'canManageSettings', label: 'Manage Settings' },
] as const;

export default function StaffPage() {
  const [showDialog, setShowDialog] = useState(false);
  const [showPerms, setShowPerms] = useState<string | null>(null);
  const [editStaff, setEditStaff] = useState<StaffMember | null>(null);
  const [form, setForm] = useState({ fullName: '', username: '', role: 'AGENT', isActive: true });
  const [permissions, setPermissions] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);

  const fetchStaff = useCallback(() => api.getStaff(), []);
  const { data, isLoading, refetch } = useApi(fetchStaff);

  const staff = ((data?.staff || data?.data || data?.employees || []) as StaffMember[]) || [];

  const openCreate = () => {
    setEditStaff(null);
    setForm({ fullName: '', username: '', role: 'AGENT', isActive: true });
    setPermissions({});
    setShowDialog(true);
  };

  const openEdit = (s: StaffMember) => {
    setEditStaff(s);
    setForm({ fullName: s.fullName || '', username: s.username || '', role: s.role || 'AGENT', isActive: s.isActive !== false });
    setShowDialog(true);
  };

  const openPerms = (s: StaffMember) => {
    const perms: Record<string, boolean> = {};
    PERMISSION_FLAGS.forEach(({ key }) => {
      perms[key] = s[key as keyof StaffMember] as boolean || false;
    });
    setPermissions(perms);
    setEditStaff(s);
    setShowPerms(s.id);
  };

  const handleSave = async () => {
    try {
      if (editStaff) {
        await api.updateStaff(editStaff.id, { fullName: form.fullName, role: form.role, isActive: form.isActive });
      } else {
        await api.addStaff({ username: form.username, fullName: form.fullName, role: form.role });
      }
      setShowDialog(false);
      refetch();
    } catch { /* */ }
  };

  const handleRemove = async (id: string) => {
    try {
      await api.removeStaff(id);
      refetch();
    } catch { /* */ }
  };

  const handleSavePerms = async () => {
    if (!editStaff) return;
    setSaving(true);
    try {
      await api.updateStaff(editStaff.id, permissions);
      setShowPerms(null);
      refetch();
    } catch { /* */ }
    setSaving(false);
  };

  const handleTogglePerm = (key: string) => {
    setPermissions((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Staff</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Manage your team members</p>
        </div>
        <button onClick={openCreate}
          className="px-4 py-2 rounded-lg bg-emerald-500 text-white text-sm font-medium hover:bg-emerald-600 transition-all flex items-center gap-2">
          <Plus className="w-4 h-4" /> Add Staff
        </button>
      </div>

      <div className="rounded-xl border border-border bg-card">
        {isLoading ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin" />
          </div>
        ) : staff.length === 0 ? (
          <div className="py-12 text-center">
            <p className="text-sm text-muted-foreground">No staff members yet</p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {staff.map((s) => (
              <div key={s.id} className="flex items-center gap-4 px-5 py-4">
                <div className="w-10 h-10 rounded-full bg-primary/10 text-primary flex items-center justify-center">
                  <User className="w-5 h-5" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground">{s.fullName || s.username || 'Unknown'}</p>
                  <p className="text-xs text-muted-foreground">
                    {s.username && `@${s.username}`}
                    {s.email && ` • ${s.email}`}
                  </p>
                  {s.branchName && (
                    <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                      <MapPin className="w-3 h-3" /> {s.branchName}
                    </p>
                  )}
                </div>
                <span className="text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary">
                  {s.role || 'AGENT'}
                </span>
                <span className={`text-xs px-2 py-0.5 rounded-full ${s.isActive !== false ? 'bg-emerald-500/10 text-emerald-400' : 'bg-muted text-muted-foreground'}`}>
                  {s.isActive !== false ? 'Active' : 'Inactive'}
                </span>
                <button onClick={() => openPerms(s)} className="p-2 rounded-lg hover:bg-accent text-muted-foreground hover:text-foreground transition-colors" title="Permissions">
                  <Shield className="w-4 h-4" />
                </button>
                <button onClick={() => openEdit(s)} className="p-2 rounded-lg hover:bg-accent text-muted-foreground hover:text-foreground transition-colors">
                  <Pencil className="w-4 h-4" />
                </button>
                <button onClick={() => handleRemove(s.id)} className="p-2 rounded-lg hover:bg-red-500/10 text-muted-foreground hover:text-red-400 transition-colors">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Edit/Create Dialog */}
      {showDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowDialog(false)}>
          <div className="bg-card rounded-xl border border-border p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-semibold text-foreground mb-4">{editStaff ? 'Edit Staff' : 'Add Staff'}</h2>
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-foreground mb-1">Full Name</label>
                <input value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring" />
              </div>
              {!editStaff && (
                <div>
                  <label className="block text-sm font-medium text-foreground mb-1">Username</label>
                  <input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })}
                    className="w-full px-3 py-2 rounded-lg border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring" />
                </div>
              )}
              <div>
                <label className="block text-sm font-medium text-foreground mb-1">Role</label>
                <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring">
                  <option value="AGENT">Agent</option>
                  <option value="ADMIN">Admin</option>
                </select>
              </div>
              {editStaff && (
                <label className="flex items-center gap-2 text-sm text-foreground">
                  <input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} className="rounded border-border" />
                  Active
                </label>
              )}
            </div>
            <div className="flex gap-3 mt-5">
              <button onClick={() => setShowDialog(false)} className="flex-1 py-2 rounded-lg border border-border text-sm font-medium text-foreground hover:bg-accent transition-colors">Cancel</button>
              <button onClick={handleSave} disabled={!form.fullName && !form.username} className="flex-1 py-2 rounded-lg bg-emerald-500 text-white text-sm font-medium hover:bg-emerald-600 disabled:opacity-50 transition-colors">Save</button>
            </div>
          </div>
        </div>
      )}

      {/* Permissions Dialog */}
      {showPerms && editStaff && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowPerms(null)}>
          <div className="bg-card rounded-xl border border-border p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 mb-4">
              <Shield className="w-5 h-5 text-muted-foreground" />
              <h2 className="text-lg font-semibold text-foreground">Permissions</h2>
            </div>
            <p className="text-sm text-muted-foreground mb-4">
              {editStaff.fullName || editStaff.username}
              {editStaff.branchName && <span className="flex items-center gap-1 mt-0.5"><MapPin className="w-3 h-3" /> {editStaff.branchName}</span>}
            </p>
            <div className="space-y-3">
              {PERMISSION_FLAGS.map(({ key, label }) => (
                <label key={key} className="flex items-center gap-3 text-sm text-foreground cursor-pointer">
                  <input
                    type="checkbox"
                    checked={permissions[key] || false}
                    onChange={() => handleTogglePerm(key)}
                    className="rounded border-border"
                  />
                  {label}
                </label>
              ))}
            </div>
            <div className="flex gap-3 mt-5">
              <button onClick={() => setShowPerms(null)} className="flex-1 py-2 rounded-lg border border-border text-sm font-medium text-foreground hover:bg-accent transition-colors">Cancel</button>
              <button onClick={handleSavePerms} disabled={saving} className="flex-1 py-2 rounded-lg bg-emerald-500 text-white text-sm font-medium hover:bg-emerald-600 disabled:opacity-50 transition-colors flex items-center justify-center gap-2">
                {saving && <Loader2 className="w-4 h-4 animate-spin" />}
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
