import { useState } from 'react';
import type { Difficulty, LoanState } from '../../domain/operations/operationsTypes';
import type { LoanRequest } from '../../domain/operations/finance';
import { money } from './OperationsSummary';

export function FinancePanel({ difficulty, cashCents, loans, pending, onDifficulty, onTakeLoan, onRepay }: {
  difficulty: Difficulty; cashCents: number; loans: LoanState[]; pending: boolean;
  onDifficulty: (difficulty: Difficulty) => Promise<boolean>; onTakeLoan: (request: LoanRequest) => Promise<boolean>; onRepay: (id: string, amount: number) => Promise<boolean>;
}) {
  const [id, setId] = useState(''); const [amount, setAmount] = useState('5000');
  const debt = loans.reduce((sum, loan) => sum + loan.outstandingCents, 0);
  return <section aria-label="财务管理" className="action-card finance-panel"><h3>财务管理</h3><div className="finance-head"><p>现金 <strong>{money(cashCents)}</strong></p><p>负债 <strong>{money(debt)}</strong></p></div><label>经营难度<select aria-label="经营难度" value={difficulty} disabled={pending} onChange={e => void onDifficulty(e.target.value as Difficulty)}><option value="casual">轻松模式</option><option value="management">管理模式</option></select></label><p className="mode-note">{difficulty === 'casual' ? '轻松模式：资金短缺时提供安全周转。' : '管理模式'}</p>
    <div className="loan-form"><label>贷款名称<input aria-label="贷款名称" value={id} onChange={e => setId(e.target.value)} /></label><label>贷款金额（元）<input aria-label="贷款金额（元）" type="number" min="1" value={amount} onChange={e => setAmount(e.target.value)} /></label><button disabled={pending} onClick={async () => { if (await onTakeLoan({ id, amountCents: Math.round(Number(amount) * 100), dailyInterestBps: 10, termDays: 30 })) setId(''); }}>申请贷款</button></div>
    <div className="loan-list">{loans.length === 0 ? <p>当前没有贷款。</p> : loans.map(loan => <article key={loan.id}><div><strong>{loan.id}</strong><span>剩余 {money(loan.outstandingCents)} · 日利率 {loan.dailyInterestBps / 100}%</span></div><button disabled={pending} onClick={() => void onRepay(loan.id, loan.minimumPaymentCents)}>偿还最低还款</button></article>)}</div>
  </section>;
}
