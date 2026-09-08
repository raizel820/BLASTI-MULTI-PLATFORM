import { useCallback, useState } from 'react';
import { Plus, Pencil, Trash2, Loader2 } from 'lucide-react';
import api from '@/api/client';
import { useApi } from '@/hooks/use-api';

interface Service {
  id: string;
  name: string;
  nameAr?: string;
  nameFr?: string;
  prefix?: string;
  estimatedWaitMinutes?: number;
  isActive?: boolean;
  branchId?: string;
}

export default function ServicesPage() {
  const [showDialog, setShowDialog] = useState(false);
  const [editService, setEditService] = useState<Service | null>(null);
  const [form, setForm] = useState({ name: '', prefix: '', estimatedWaitMinutes: 15 });

  const fetchServices = useCallback(() => api.getServices(), []);
  const { data, isLoading, refetch } = useApi(fetchServices);

  const services = ((data?.services || data?.data || []) as Service[]) || [];

  const openCreate = () => {
    setEditService(null);
    setForm({ name: '', prefix: '', estimatedWaitMinutes: 15 });
    setShowDialog(true);
  };

  const openEdit = (s: Service) => {
    setEditService(s);
    setForm({ name: s.name, prefix: s.prefix || '', estimatedWaitMinutes: s.estimatedWaitMinutes || 15 });
    setShowDialog(true);
  };

  const handleSave = async () => {
    try {
      if (editService) {
        await api.updateService(editService.id, form);
      } else {
        await api.createService(form);
      }
      setShowDialog(false);
      refetch();
    } catch { /* */ }
  };

  const handleDelete = async (id: string) => {
    try {
      await api.deleteService(id);
      refetch();
    } catch { /* */ }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Services</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Manage your queue services</p>
        </div>
        <button onClick={openCreate}
          className="px-4 py-2 rounded-lg bg-emerald-500 text-white text-sm font-medium hover:bg-emerald-600 transition-all flex items-center gap-2">
          <Plus className="w-4 h-4" /> Add Service
        </button>
      </div>

      <div className="rounded-xl border border-border bg-card">
        {isLoading ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin" />
          </div>
        ) : services.length === 0 ? (
          <div className="py-12 text-center">
            <p className="text-sm text-muted-foreground">No services yet</p>
            <button onClick={openCreate} className="text-sm text-emerald-400 hover:text-emerald-300 mt-2">
              Create your first service
            </button>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {services.map((s) => (
              <div key={s.id} className="flex items-center gap-4 px-5 py-4">
                <div className="w-10 h-10 rounded-lg bg-primary/10 text-primary flex items-center justify-center font-bold text-sm">
                  {s.prefix || s.name.charAt(0)}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground">{s.name}</p>
                  <p className="text-xs text-muted-foreground">
                    Prefix: {s.prefix || '—'} • Est. wait: {s.estimatedWaitMinutes || 15} min
                    {s.nameAr && ` • AR: ${s.nameAr}`}
                    {s.nameFr && ` • FR: ${s.nameFr}`}
                  </p>
                </div>
                <span className={`text-xs px-2 py-0.5 rounded-full ${s.isActive !== false ? 'bg-emerald-500/10 text-emerald-400' : 'bg-muted text-muted-foreground'}`}>
                  {s.isActive !== false ? 'Active' : 'Inactive'}
                </span>
                <button onClick={() => openEdit(s)} className="p-2 rounded-lg hover:bg-accent text-muted-foreground hover:text-foreground transition-colors">
                  <Pencil className="w-4 h-4" />
                </button>
                <button onClick={() => handleDelete(s.id)} className="p-2 rounded-lg hover:bg-red-500/10 text-muted-foreground hover:text-red-400 transition-colors">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Dialog */}
      {showDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowDialog(false)}>
          <div className="bg-card rounded-xl border border-border p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-semibold text-foreground mb-4">
              {editService ? 'Edit Service' : 'New Service'}
            </h2>
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-foreground mb-1">Name</label>
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                  placeholder="e.g. Consultation" />
              </div>
              <div>
                <label className="block text-sm font-medium text-foreground mb-1">Prefix</label>
                <input value={form.prefix} onChange={(e) => setForm({ ...form, prefix: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                  placeholder="e.g. C" maxLength={3} />
              </div>
              <div>
                <label className="block text-sm font-medium text-foreground mb-1">Est. Wait (min)</label>
                <input type="number" value={form.estimatedWaitMinutes} onChange={(e) => setForm({ ...form, estimatedWaitMinutes: parseInt(e.target.value) || 15 })}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring" />
              </div>
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
