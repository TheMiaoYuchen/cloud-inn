import { useRef, useState, type FormEvent } from "react";
import { reliabilityErrorCode } from "../application/reliabilityUi";
import { useReliability } from "../state/ReliabilityProvider";

export function FirstRunPage() {
  const { port, registerSave } = useReliability();
  const nameRef = useRef<HTMLInputElement>(null);
  const tokenRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const create = async (setupAi: boolean) => {
    setPending(true);
    setNotice(null);
    try {
      if (setupAi) {
        const input = tokenRef.current;
        const token = input?.value ?? "";
        try {
          await port.setProviderToken(token);
        } finally {
          if (input) input.value = "";
        }
      }
      const save = await port.createSave(nameRef.current?.value ?? "");
      registerSave(save);
    } catch (error) {
      setNotice(`操作未完成（${reliabilityErrorCode(error)}）`);
    } finally {
      setPending(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void create(true);
  };

  return (
    <main className="page reliability-page first-run-page">
      <p className="eyebrow">欢迎入住</p>
      <h1>创建你的 Cloud Inn</h1>
      <p className="reliability-lead">先为本地存档取名。AI 效果图完全可选，跳过后所有经营与设计功能仍可使用。</p>
      <form className="reliability-card first-run-form" onSubmit={submit}>
        <label htmlFor="first-save-name">存档名称</label>
        <input id="first-save-name" ref={nameRef} name="displayName" required maxLength={40} autoFocus />
        <fieldset>
          <legend>可选：启用 AI 效果图</legend>
          <p className="muted">令牌只发送到系统钥匙串，不会保存到游戏存档或界面状态。</p>
          <label htmlFor="first-provider-token">提供方令牌</label>
          <input
            id="first-provider-token"
            ref={tokenRef}
            name="providerToken"
            type="password"
            autoComplete="off"
            spellCheck={false}
          />
        </fieldset>
        {notice && <p className="reliability-error" role="alert">{notice}</p>}
        <div className="reliability-actions">
          <button type="button" disabled={pending} onClick={() => void create(false)}>跳过 AI，开始经营</button>
          <button type="submit" disabled={pending}>保存令牌并开始</button>
        </div>
      </form>
    </main>
  );
}

