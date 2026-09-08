import { useCallback, useState } from 'react';
import { Plus, Pencil, Trash2, MapPin, Loader2 } from 'lucide-react';
import api from '@/api/client';
import { useApi } from '@/hooks/use-api';

interface Branch {
  id: string;
  name: string;
  nameAr?: string;
  nameFr?: string;
  address?: string;
  phone?: string;
  isActive?: boolean;
  isMain?: boolean;
  _count?: { counters: number; staff: number };
}

export default function BranchesPage() {
  const [showDialog, setShowDialog] = useState(false);
  const [editBranch, setEditBranch] = useState<Branch | null>(null);
  const [form, setForm] = useState({ name: '', address: '', phone: '', nameAr: '', nameFr: '', isMain: false });

  const fetchBranches = useCallback(() => api.getBranches(), []);
  const { data, isLoading, refetch } = useApi(fetchBranches);

  const branches = ((data?.branches || data?.data || []) as Branch[]) || [];

  const openCreate = () => {
    setEditBranch(null);
    setForm({ name: '', address: '', phone: '', nameAr: '', nameFr: '', isMain: false });
    setShowDialog(true);
  };

  const openEdit = (b: Branch) => {
    setEditBranch(b);
    setForm({ name: b.name, address: b.address || '', phone: b.phone || '', nameAr: b.nameAr || '', nameFr: b.nameFr || '', isMain: b.isMain || false });
    setShowDialog(true);
  };

  const handleSave = async () => {
    try {
      if (editBranch) {
        await api.updateBranch(editBranch.id, form);
      } else {
        await api.createBranch(form);
      }
      setShowDialog(false);
      refetch();
    } catch { /* */ }
  };

  const handleDelete = async (id: string) => {
    try {
      await api.deleteBranch(id);
      refetch();
    } catch { /* */ }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Branches</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Manage your branches and counters</p>
        </div>
        <button onClick={openCreate}
          className="px-4 py-2 rounded-lg bg-emerald-500 text-white text-sm font-medium hover:bg-emerald-600 transition-all flex items-center gap-2">
          <Plus className="w-4 h-4" /> Add Branch
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {isLoading ? (
          <div className="col-span-2 flex items-center justify-center py-12 text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin" />
          </div>
        ) : branches.length === 0 ? (
          <div className="col-span-2 rounded-xl border border-border bg-card py-12 text-center">
            <p className="text-sm text-muted-foreground">No branches yet</p>
          </div>
        ) : (
          branches.map((b) => (
            <div key={b.id} className="rounded-xl border border-border bg-card p-5">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
                    <MapPin className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                      {b.name}
                      {b.isMain && <span className="text-[10px] bg-emerald-500/20 text-emerald-400 px-1.5 py-0.5 rounded-full">Main</span>}
                    </h3>
                    {b.address && <p className="text-xs text-muted-foreground mt-0.5">{b.address}</p>}
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <button onClick={() => openEdit(b)} className="p-1.5 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors">
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <button onClick={() => handleDelete(b.id)} className="p-1.5 rounded-md hover:bg-red-500/10 text-muted-foreground hover:text-red-400 transition-colors">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
              <div className="mt-4 flex items-center gap-4 text-xs text-muted-foreground">
                <span>{b._count?.counters || 0} counters</span>
                <span>{b._count?.staff || 0} staff</span>
                {b.phone && <span>{b.phone}</span>}
                <span className={b.isActive !== false ? 'text-emerald-400' : 'text-muted-foreground'}>
                  {b.isActive !== false ? 'Active' : 'Inactive'}
                </span>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Dialog */}
      {showDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowDialog(false)}>
          <div className="bg-card rounded-xl border border-border p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-semibold text-foreground mb-4">{editBranch ? 'Edit Branch' : 'New Branch'}</h2>
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-foreground mb-1">Name</label>
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                  placeholder="Branch name" />
              </div>
              <div>
                <label className="block text-sm font-medium text-foreground mb-1">Address</label>
                <input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                  placeholder="Address" />
              </div>
              <div>
                <label className="block text-sm font-medium text-foreground mb-1">Phone</label>
                <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                  placeholder="Phone number" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-foreground mb-1">Name (Arabic)</label>
                  <input value={form.nameAr} onChange={(e) => setForm({ ...form, nameAr: e.target.value })}
                    className="w-full px-3 py-2 rounded-lg border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring" dir="rtl" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-foreground mb-1">Name (French)</label>
                  <input value={form.nameFr} onChange={(e) => setForm({ ...form, nameFr: e.target.value })}
                    className="w-full px-3 py-2 rounded-lg border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring" />
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm text-foreground">
                <input type="checkbox" checked={form.isMain} onChange={(e) => setForm({ ...form, isMain: e.target.checked })}
                  className="rounded border-border" />
                Main branch
              </label>
            </div>
            <div className="flex gap-3 mt-5">
              <button onClick={() => setShowDialog(false)} className="flex-1 py-2 rounded-lg border border-border text-sm font-medium text-foreground hover:bg-accent transition-colors">Cancel</button>
              <button onClick={handleSave} disabled={!form.name} className="flex-1 py-2 rounded-lg bg-emerald-500 text-white text-sm font-medium hover:bg-emerald-600 disabled:opacity-50 transition-colors">Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
