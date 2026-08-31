'use client';

import { useState, useEffect } from 'react';
import { useLanguage } from '@/hooks/use-language';
import { isRTL } from '@/i18n';
import { motion } from 'framer-motion';
import { Shield, Check, Zap, UserCheck, Settings, Eye, GitBranch, Clock, Download, User } from 'lucide-react';

interface StaffPermissions {
  canManageQueue: boolean;
  canManageServices: boolean;
  canManageStaff: boolean;
  canViewAnalytics: boolean;
  canManageBranches: boolean;
  canManageWorkingHours: boolean;
  canExportData: boolean;
  canManageProfile: boolean;
}

interface StaffPermissionsEditorProps {
  permissions: StaffPermissions;
  onChange: (permissions: StaffPermissions) => void;
  staffRole?: string;
}

const PERMISSION_PRESETS: Record<string, Partial<StaffPermissions>> = {
  fullAccess: {
    canManageQueue: true,
    canManageServices: true,
    canManageStaff: true,
    canViewAnalytics: true,
    canManageBranches: true,
    canManageWorkingHours: true,
    canExportData: true,
    canManageProfile: true,
  },
  queueOnly: {
    canManageQueue: true,
    canManageServices: false,
    canManageStaff: false,
    canViewAnalytics: false,
    canManageBranches: false,
    canManageWorkingHours: false,
    canExportData: false,
    canManageProfile: false,
  },
  basicStaff: {
    canManageQueue: true,
    canManageServices: false,
    canManageStaff: false,
    canViewAnalytics: true,
    canManageBranches: false,
    canManageWorkingHours: false,
    canExportData: false,
    canManageProfile: false,
  },
  manager: {
    canManageQueue: true,
    canManageServices: true,
    canManageStaff: false,
    canViewAnalytics: true,
    canManageBranches: true,
    canManageWorkingHours: true,
    canExportData: false,
    canManageProfile: true,
  },
};

export const DEFAULT_PERMISSIONS: StaffPermissions = {
  canManageQueue: true,
  canManageServices: false,
  canManageStaff: false,
  canViewAnalytics: true,
  canManageBranches: false,
  canManageWorkingHours: false,
  canExportData: false,
  canManageProfile: false,
};

export function parsePermissions(permStr: string | null | undefined): StaffPermissions {
  if (!permStr) return DEFAULT_PERMISSIONS;
  try {
    const parsed = JSON.parse(permStr);
    return { ...DEFAULT_PERMISSIONS, ...parsed };
  } catch {
    return DEFAULT_PERMISSIONS;
  }
}

export function StaffPermissionsEditor({ permissions, onChange, staffRole }: StaffPermissionsEditorProps) {
  const { t, lang } = useLanguage();
  const rtl = isRTL(lang);

  const permissionItems: { key: keyof StaffPermissions; icon: React.ReactNode; labelKey: string }[] = [
    { key: 'canManageQueue', icon: <Zap className="h-4 w-4" />, labelKey: 'manageQueue' },
    { key: 'canManageServices', icon: <Settings className="h-4 w-4" />, labelKey: 'manageServices' },
    { key: 'canManageStaff', icon: <UserCheck className="h-4 w-4" />, labelKey: 'manageStaff' },
    { key: 'canViewAnalytics', icon: <Eye className="h-4 w-4" />, labelKey: 'viewAnalytics' },
    { key: 'canManageBranches', icon: <GitBranch className="h-4 w-4" />, labelKey: 'manageBranches' },
    { key: 'canManageWorkingHours', icon: <Clock className="h-4 w-4" />, labelKey: 'manageWorkingHours' },
    { key: 'canExportData', icon: <Download className="h-4 w-4" />, labelKey: 'exportData' },
    { key: 'canManageProfile', icon: <User className="h-4 w-4" />, labelKey: 'manageProfile' },
  ];

  const presets = [
    { key: 'fullAccess', label: t('fullAccess'), icon: <Shield className="h-4 w-4" /> },
    { key: 'queueOnly', label: t('queueOnly'), icon: <Zap className="h-4 w-4" /> },
    { key: 'basicStaff', label: t('basicStaff'), icon: <UserCheck className="h-4 w-4" /> },
    { key: 'manager', label: t('managerPerm'), icon: <Settings className="h-4 w-4" /> },
  ];

  const activeCount = Object.values(permissions).filter(Boolean).length;

  const togglePermission = (key: keyof StaffPermissions) => {
    onChange({ ...permissions, [key]: !permissions[key] });
  };

  const applyPreset = (presetKey: string) => {
    const preset = PERMISSION_PRESETS[presetKey];
    if (preset) {
      onChange({ ...DEFAULT_PERMISSIONS, ...preset });
    }
  };

  return (
    <div className="space-y-4">
      {/* Permission description */}
      <p className="text-sm text-gray-500">{t('permissionDesc')}</p>

      {/* Active permissions count */}
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-emerald-50 border border-emerald-200">
          <Shield className="h-3.5 w-3.5 text-emerald-600" />
          <span className="text-xs font-semibold text-emerald-700">
            {activeCount}/{permissionItems.length} {t('activePermissions')}
          </span>
        </div>
      </div>

      {/* Preset templates */}
      <div className="space-y-2">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
          {t('presetTemplates')}
        </p>
        <div className="flex flex-wrap gap-2">
          {presets.map((preset) => (
            <motion.button
              key={preset.key}
              whileHover={{ scale: 1.03 }}
              whileTap={{ scale: 0.97 }}
              onClick={() => applyPreset(preset.key)}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-gray-200 bg-white hover:border-emerald-300 hover:bg-emerald-50 text-xs font-medium text-gray-700 transition-all"
            >
              {preset.icon}
              {preset.label}
            </motion.button>
          ))}
        </div>
      </div>

      {/* Individual permissions */}
      <div className="space-y-2">
        {permissionItems.map((item) => {
          const isActive = permissions[item.key];
          return (
            <motion.div
              key={item.key}
              whileHover={{ x: rtl ? -4 : 4 }}
              className={`flex items-center justify-between p-3 rounded-xl border transition-all cursor-pointer ${
                isActive
                  ? 'border-emerald-200 bg-emerald-50'
                  : 'border-gray-100 bg-gray-50 hover:border-gray-200'
              }`}
              onClick={() => togglePermission(item.key)}
            >
              <div className={`flex items-center gap-3 ${rtl ? 'flex-row-reverse' : ''}`}>
                <div className={`h-8 w-8 rounded-lg flex items-center justify-center ${
                  isActive ? 'bg-emerald-100 text-emerald-600' : 'bg-gray-200 text-gray-400'
                }`}>
                  {item.icon}
                </div>
                <span className={`text-sm font-medium ${isActive ? 'text-gray-800' : 'text-gray-500'}`}>
                  {t(item.labelKey as any)}
                </span>
              </div>
              <div className={`h-6 w-11 rounded-full relative transition-colors ${
                isActive ? 'bg-emerald-500' : 'bg-gray-300'
              }`}>
                <motion.div
                  animate={{ x: isActive ? (rtl ? -20 : 20) : 0 }}
                  transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                  className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm"
                  style={{ left: rtl ? undefined : 2, right: rtl ? 2 : undefined }}
                />
              </div>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}
