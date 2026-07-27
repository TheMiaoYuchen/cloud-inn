import { useEffect, useState } from 'react';
import { DEPARTMENT_CATALOG, type DepartmentConfiguration, type LeaderSpecialtyId } from '../../domain/operations/departmentCatalog';
import type { DepartmentId, DepartmentState } from '../../domain/operations/operationsTypes';

export function DepartmentPanel({ departments, pending, onSave }: { departments: Record<DepartmentId, DepartmentState>; pending: boolean; onSave: (input: DepartmentConfiguration) => Promise<boolean> }) {
  const [selected, setSelected] = useState<DepartmentId>('frontOffice');
  const initial = departments.frontOffice;
  const [form, setForm] = useState({ staffing: String(initial.staffing), budget: String(initial.dailyBudgetCents / 100), training: String(initial.trainingBps / 100), standard: String(initial.serviceStandardBps / 100), leader: initial.leaderSpecialty ?? '' });
  const [notice, setNotice] = useState('');
  const entry = DEPARTMENT_CATALOG.find(item => item.id === selected)!;
  const current = departments[selected];
  useEffect(() => setForm({ staffing: String(current.staffing), budget: String(current.dailyBudgetCents / 100), training: String(current.trainingBps / 100), standard: String(current.serviceStandardBps / 100), leader: current.leaderSpecialty ?? '' }), [current]);
  const save = async () => {
    const ok = await onSave({ id: selected, staffing: Number(form.staffing), dailyBudgetCents: Math.round(Number(form.budget) * 100), trainingBps: Math.round(Number(form.training) * 100), serviceStandardBps: Math.round(Number(form.standard) * 100), leaderSpecialty: form.leader ? form.leader as LeaderSpecialtyId : undefined });
    setNotice(ok ? `${entry.name}配置已保存` : '');
  };
  return <section aria-label="部门管理" className="action-card department-panel"><h3>部门管理</h3><div className="department-tabs" role="tablist" aria-label="酒店部门">{DEPARTMENT_CATALOG.map(item => <button role="tab" aria-selected={selected === item.id} key={item.id} onClick={() => { setSelected(item.id); setNotice(''); }}>{item.name}</button>)}</div>
    <div className="form-grid"><label>负责人专长<select aria-label="负责人专长" value={form.leader} onChange={e => setForm({ ...form, leader: e.target.value })}><option value="">暂未任命</option>{entry.leaderSpecialties.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>员工人数<input aria-label="员工人数" type="number" min="0" max="500" value={form.staffing} onChange={e => setForm({ ...form, staffing: e.target.value })} /></label><label>每日预算（元）<input aria-label="每日预算（元）" type="number" min="0" value={form.budget} onChange={e => setForm({ ...form, budget: e.target.value })} /></label><label>培训水平（%）<input aria-label="培训水平（%）" type="number" min="0" max="100" value={form.training} onChange={e => setForm({ ...form, training: e.target.value })} /></label><label>服务标准（%）<input aria-label="服务标准（%）" type="number" min="0" max="100" value={form.standard} onChange={e => setForm({ ...form, standard: e.target.value })} /></label></div>
    <button disabled={pending} onClick={() => void save()}>保存部门配置</button>{notice && <p className="success-note" role="status">{notice}</p>}
  </section>;
}
