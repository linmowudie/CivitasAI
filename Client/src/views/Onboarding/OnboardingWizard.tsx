/**
 * OnboardingWizard——首次运行初始化引导（全屏）。
 *
 * 七步：欢迎（目录透明化）→ 个性化 → 供应商 → 密钥与连通性 → 默认模型 →
 * 使用引导 → 完成。
 *
 * 设计原则：
 * - 任何一步都可以"跳过引导"（`onFinish` 让主界面接管；未配置模型时主界面会提示）；
 * - 关键步骤有**硬校验**（API Key 必须实测通过；仲裁模型 ≥3 否则后端启动失败）；
 * - 不用营销文案，直接展示"东西存在哪、能不能跑"。
 */

import { useEffect } from 'react';
import {
  ShieldCheck, FolderOpen, Rocket, Eye, KeyRound, Cpu, BookOpen, CheckCircle2,
  AlertTriangle, Loader2, ArrowLeft, ArrowRight, X,
} from 'lucide-react';

import { PRESET_PROVIDERS } from '@/stores/modelStore';
import {
  ONBOARDING_STEPS,
  canProceed,
  useOnboardingStore,
  type OnboardingStepId,
} from '@/stores/onboardingStore';
import styles from './Onboarding.module.css';

interface OnboardingWizardProps {
  /** 引导结束（完成或跳过）→ 交给主界面 */
  onFinish: () => void;
}

const STEP_ICONS: Record<OnboardingStepId, typeof Eye> = {
  welcome: Rocket,
  personalize: Eye,
  provider: Cpu,
  credentials: KeyRound,
  routing: Cpu,
  guide: BookOpen,
  done: CheckCircle2,
};

export default function OnboardingWizard({ onFinish }: OnboardingWizardProps) {
  const s = useOnboardingStore();
  const stepDef = ONBOARDING_STEPS[s.step]!;
  const isLast = s.step === ONBOARDING_STEPS.length - 1;
  const proceed = canProceed(stepDef.id, s);

  // 首次进入：确保拿到了目录与现状快照
  useEffect(() => {
    if (!s.checked) void s.check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className={styles.shell}>
      {/* 左侧：品牌 + 步骤 */}
      <aside className={styles.side}>
        <div className={styles.brand}>
          <span className={styles.brandMark}>城</span>
          <div>
            <div className={styles.brandTitle}>Civitas AI</div>
            <div className={styles.brandSub}>智体城邦 · 初始化引导</div>
          </div>
        </div>

        <ol className={styles.steps}>
          {ONBOARDING_STEPS.map((step, i) => {
            const Icon = STEP_ICONS[step.id];
            const active = i === s.step;
            const done = i < s.step;
            return (
              <li key={step.id} className={`${styles.stepItem} ${active ? styles.stepActive : ''} ${done ? styles.stepDone : ''}`}>
                <span className={styles.stepDot}>
                  {done ? <CheckCircle2 size={13} /> : <Icon size={13} />}
                </span>
                <span className={styles.stepText}>
                  <span className={styles.stepTitle}>{step.title}</span>
                  <span className={styles.stepSub}>{step.subtitle}</span>
                </span>
              </li>
            );
          })}
        </ol>

        <div className={styles.sideFoot}>
          <button className={styles.skipBtn} onClick={() => void s.skip().then(onFinish)}>
            <X size={12} /> 跳过引导，稍后再配置
          </button>
        </div>
      </aside>

      {/* 右侧：步骤内容 */}
      <main className={styles.main}>
        <header className={styles.head}>
          <h1 className={styles.title}>{stepDef.title}</h1>
          <p className={styles.subtitle}>{stepDef.subtitle}</p>
        </header>

        <div className={styles.body}>
          {s.step === 0 && <WelcomeStep />}
          {s.step === 1 && <PersonalizeStep />}
          {s.step === 2 && <ProviderStep />}
          {s.step === 3 && <CredentialsStep />}
          {s.step === 4 && <RoutingStep />}
          {s.step === 5 && <GuideStep />}
          {s.step === 6 && <DoneStep />}
        </div>

        {/* 提示条 */}
        {s.notice && (
          <div className={`${styles.notice} ${s.notice.kind === 'ok' ? styles.noticeOk : s.notice.kind === 'warn' ? styles.noticeWarn : styles.noticeError}`}>
            {s.notice.kind === 'ok' ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}
            <span>{s.notice.text}</span>
          </div>
        )}

        <footer className={styles.foot}>
          <button className={styles.ghostBtn} disabled={s.step === 0} onClick={s.prev}>
            <ArrowLeft size={13} /> 上一步
          </button>
          <div className={styles.footRight}>
            {!isLast && (
              <button className={styles.primaryBtn} disabled={!proceed} onClick={s.next}>
                下一步 <ArrowRight size={13} />
              </button>
            )}
            {isLast && (
              <button
                className={styles.primaryBtn}
                disabled={s.finishing}
                onClick={() => void s.complete().then((ok) => { if (ok) onFinish(); })}
              >
                {s.finishing ? <Loader2 size={13} className="animate-spin" /> : <Rocket size={13} />} 开始使用
              </button>
            )}
          </div>
        </footer>
      </main>
    </div>
  );
}

// ── 步骤 1：欢迎 + 目录透明化 ───────────────────────────────────────

function PathRow({ label, value, hint, onOpen }: { label: string; value?: string; hint?: string; onOpen?: () => void }) {
  const s = useOnboardingStore();
  return (
    <div className={styles.pathRow}>
      <div className={styles.pathLabel}>{label}</div>
      <div className={styles.pathValue} title={value}>{value || '—'}</div>
      <div className={styles.pathMeta}>
        {hint && <span className={styles.pathHint}>{hint}</span>}
        {onOpen && value && (
          <button className={styles.linkBtn} onClick={() => void s.openPath(value)}>
            <FolderOpen size={11} /> 打开
          </button>
        )}
      </div>
    </div>
  );
}

function WelcomeStep() {
  const { paths, snapshot } = useOnboardingStore();
  const ok = paths?.writable ?? {};
  return (
    <div className={styles.stack}>
      <p className={styles.lead}>
        Civitas AI 是一个本地优先的多智能体工作台：**程序与数据分开存放**，
        卸载程序不会丢数据，安装目录只放工作空间产物。下面是这台机器上的实际位置。
      </p>

      <div className={styles.card}>
        <div className={styles.cardTitle}>目录契约（{paths?.mode === 'portable' ? '便携模式' : paths?.mode === 'installed' ? '安装模式' : '开发模式'}）</div>
        <PathRow label="程序（只读）" value={paths?.appRoot} hint="配置种子 / 提示词 / 技能 / 图标" />
        <PathRow label="数据（全局）" value={paths?.dataRoot} hint={`数据库·日志·密钥·设置${ok.dataRoot === false ? '（不可写）' : ''}`} onOpen={() => undefined} />
        <PathRow label="工作空间" value={paths?.workspaceRoot} hint="会话工作目录 / 沙箱 / .civitas 备份" onOpen={() => undefined} />
        <PathRow label="日志" value={paths?.logDir} hint="排障先看这里" />
        <PathRow label="用户设置" value={paths?.userConfigPath} hint="引导写这里（local.json，优先级最高）" />
      </div>

      {paths?.warnings?.length ? (
        <div className={styles.warnBox}>
          <AlertTriangle size={13} />
          <div>{paths.warnings.join('；')}</div>
        </div>
      ) : null}

      {snapshot && snapshot.providers.length > 0 && (
        <div className={styles.infoBox}>
          检测到已有 {snapshot.providers.length} 个供应商、{snapshot.models.length} 个模型；
          可以跳过引导直接使用，或继续配置默认模型。
        </div>
      )}
    </div>
  );
}

// ── 步骤 2：个性化 ──────────────────────────────────────────────────

function PersonalizeStep() {
  const { personalization, setPersonalization, paths } = useOnboardingStore();

  const pickWorkspace = async () => {
    const api = (globalThis as { window?: { electronAPI?: { pickDirectory?: () => Promise<string | null> } } }).window?.electronAPI;
    const picked = await api?.pickDirectory?.();
    if (picked) setPersonalization({ workspaceRoot: picked });
  };

  return (
    <div className={styles.stack}>
      <div className={styles.card}>
        <div className={styles.cardTitle}>日志级别</div>
        <div className={styles.segmented}>
          {(['debug', 'info', 'warn', 'error'] as const).map((level) => (
            <button
              key={level}
              className={`${styles.segBtn} ${personalization.logLevel === level ? styles.segActive : ''}`}
              onClick={() => setPersonalization({ logLevel: level })}
            >
              {level}
            </button>
          ))}
        </div>
        <p className={styles.hint}>
          默认 <code>info</code>；遇到问题时可临时改 <code>debug</code>（日志写在数据根 <code>Logs/</code>）。
        </p>
      </div>

      <div className={styles.card}>
        <div className={styles.cardTitle}>工作空间位置（可选）</div>
        <div className={styles.row}>
          <input
            className={styles.input}
            placeholder={`留空 = 默认（${paths?.workspaceRoot ?? '安装目录\\Workspace'}）`}
            value={personalization.workspaceRoot}
            onChange={(e) => setPersonalization({ workspaceRoot: e.target.value })}
          />
          <button className={styles.ghostBtn} onClick={() => void pickWorkspace()}>
            <FolderOpen size={12} /> 选择目录
          </button>
        </div>
        <p className={styles.hint}>
          会话工作目录与文件备份会落在这个根下（<code>workspaces/&lt;会话&gt;/.civitas</code>）。
          选择后**下次启动起生效**；留空沿用安装目录侧默认值。
        </p>
      </div>

      <div className={styles.card}>
        <div className={styles.cardTitle}>主题与语言</div>
        <p className={styles.hint}>
          当前版本仅提供深色主题与简体中文界面（已记录选择，后续版本可切换）。
        </p>
      </div>
    </div>
  );
}

// ── 步骤 3：供应商 ──────────────────────────────────────────────────

function ProviderStep() {
  const { draft, selectPreset } = useOnboardingStore();
  return (
    <div className={styles.stack}>
      <p className={styles.lead}>
        选择一个"OpenAI 兼容"的模型服务商。绝大多数国产/海外服务都兼容该协议；
        本地推理（Ollama / vLLM）选最下面的自定义即可。
      </p>
      <div className={styles.grid}>
        {PRESET_PROVIDERS.map((preset) => (
          <button
            key={preset.id}
            className={`${styles.providerCard} ${draft.providerId === preset.id ? styles.providerActive : ''}`}
            onClick={() => selectPreset(preset)}
          >
            <div className={styles.providerName}>{preset.name}</div>
            <div className={styles.providerUrl}>{preset.base_url}</div>
          </button>
        ))}
        <button
          className={`${styles.providerCard} ${draft.providerId === 'custom' ? styles.providerActive : ''}`}
          onClick={() => selectPreset({ id: 'custom', name: '自定义（OpenAI 兼容 / 本地推理）', base_url: '' })}
        >
          <div className={styles.providerName}>自定义 / 本地</div>
          <div className={styles.providerUrl}>Ollama、vLLM、自建网关…</div>
        </button>
      </div>
    </div>
  );
}

// ── 步骤 4：密钥与连通性 ────────────────────────────────────────────

function CredentialsStep() {
  const {
    draft, setDraft, probe, probing, probeConnection, selectedModels, toggleModel,
    probeModel, setProbeModel,
    availability, verifying, verifyProgress, verifiedAt,
    verifyAvailability, cancelVerify, selectOnlyAvailable, clearSelection,
  } = useOnboardingStore();

  /** 可用性徽标：未检测只显示序号，检测后给结论 */
  const badgeFor = (id: string): { text: string; cls: string } => {
    const status = availability[id]?.status;
    if (!status) return { text: '未检测', cls: styles.tagMuted };
    if (status === 'available') return { text: '可用', cls: styles.tagOk };
    if (status === 'unavailable') return { text: '不可用', cls: styles.tagBad };
    return { text: '未知', cls: styles.tagWarn };
  };

  const availableCount = Object.values(availability).filter((v) => v.status === 'available').length;

  return (
    <div className={styles.stack}>
      <div className={styles.card}>
        <div className={styles.cardTitle}>连接信息</div>
        <label className={styles.field}>
          <span>显示名称</span>
          <input className={styles.input} value={draft.displayName}
            onChange={(e) => setDraft({ displayName: e.target.value })}
            placeholder="例如：华为云 MaaS" />
        </label>
        <label className={styles.field}>
          <span>Base URL（OpenAI 兼容端点）</span>
          <input className={styles.input} value={draft.baseUrl}
            onChange={(e) => setDraft({ baseUrl: e.target.value })}
            placeholder="https://api.example.com/v1" />
        </label>
        <label className={styles.field}>
          <span>API Key</span>
          <input className={styles.input} type="password" value={draft.apiKey}
            onChange={(e) => setDraft({ apiKey: e.target.value })}
            placeholder="sk-…（仅加密保存在本机）" />
        </label>
        <div className={styles.row}>
          <button className={styles.primaryBtn} disabled={probing} onClick={() => void probeConnection()}>
            {probing ? <Loader2 size={13} className="animate-spin" /> : <ShieldCheck size={13} />} 测试连接
          </button>
          <span className={styles.hint}>
            Key 经系统加密（DPAPI）保存到 <code>.secrets</code>，**不写日志、不上传**。
          </span>
        </div>

        {/*
          探测模型可手选（2026-10-07）：`/models` 常把 embedding/TTS/ASR 与对话模型混在一起，
          自动挑错会让人误以为"Key 有问题"。留空 = 自动挑对话可用模型并逐个重试。
        */}
        {probe && probe.models.length > 0 && (
          <label className={styles.field}>
            <span>
              用于"测试连接"的模型
              <em className={styles.fieldHint}>留空 = 自动挑选对话可用模型（排除 embedding/tts/asr 等）</em>
            </span>
            <select
              className={styles.select}
              value={probeModel}
              onChange={(e) => setProbeModel(e.target.value)}
            >
              <option value="">自动（推荐）</option>
              {probe.models.slice(0, 60).map((m) => (
                <option key={m.id} value={m.id}>{m.id}</option>
              ))}
            </select>
          </label>
        )}
      </div>

      {probe && (
        <div className={styles.card}>
          <div className={styles.cardTitle}>
            探测结果：
            {/* 如实区分"未探测 / 鉴权失败 / 端点不提供 / 成功"（早期版本把 401 显示成"该端点不提供"，误导用户） */}
            {probe.listOk ? <span className={styles.tagOk}>模型列表 ✓ {probe.models.length} 个</span>
              : probe.listStatus === 401 || probe.listStatus === 403
                ? <span className={styles.tagWarn}>模型列表：鉴权失败（HTTP {probe.listStatus}）</span>
                : probe.listNotProvided
                  ? <span className={styles.tagWarn}>模型列表 —（该端点确实不提供）</span>
                  : <span className={styles.tagWarn}>模型列表：未取得（HTTP {probe.listStatus ?? '—'}）</span>}
            {probe.chatOk
              ? <span className={styles.tagOk}>对话 ✓ {probe.chatModelUsed ? `${probe.chatModelUsed} · ` : ''}{probe.latencyMs}ms{probe.chatAttempts && probe.chatAttempts > 1 ? `（重试 ${probe.chatAttempts} 次）` : ''}</span>
              : probe.chatAttempted
                ? <span className={styles.tagWarn}>对话未通过{probe.chatModelUsed ? `（${probe.chatModelUsed}）` : ''}{probe.chatAttempts && probe.chatAttempts > 1 ? `，已试 ${probe.chatAttempts} 个模型` : ''}</span>
                : <span className={styles.tagWarn}>对话：未探测（先解决上面的问题）</span>}
          </div>

          {/* 供应商原话：用户据此判断是"Key 抄错"还是"账号/额度问题" */}
          {probe.providerMessage && (
            <div className={styles.providerMsg}>
              <div className={styles.providerMsgLabel}>供应商原话</div>
              <code className={styles.providerMsgBody}>{probe.providerMessage}</code>
            </div>
          )}

          {/* Key 被自动清理过：如实告知，不静默改用户输入 */}
          {probe.keySanitized?.length ? (
            <div className={styles.infoBox}>
              已自动清理 Key：{probe.keySanitized.join('、')}（粘贴带入的字符会导致 401，请确认清理后仍是你自己的 Key）。
            </div>
          ) : null}

          {probe.models.length > 0 && (
            <>
              {/* 模型导入重设计：先逐个校验可用性，再由用户勾选（绝不自动全量导入） */}
              <div className={styles.row}>
                <button
                  className={styles.primaryBtn}
                  disabled={verifying}
                  onClick={() => void verifyAvailability()}
                >
                  {verifying
                    ? <Loader2 size={13} className="animate-spin" />
                    : <ShieldCheck size={13} />}
                  {verifying ? `校验中 ${verifyProgress.checked}/${verifyProgress.total}` : '校验可用性（逐个探测）'}
                </button>
                {verifying && (
                  <button className={styles.ghostBtn} onClick={cancelVerify}>取消</button>
                )}
                <button className={styles.ghostBtn} disabled={verifying || availableCount === 0} onClick={selectOnlyAvailable}>
                  仅选可用（{availableCount}）
                </button>
                <button className={styles.ghostBtn} disabled={selectedModels.length === 0} onClick={clearSelection}>
                  清空勾选
                </button>
                <span className={styles.hint}>
                  已勾选 <b>{selectedModels.length}</b> 个 · 共 {probe.models.length} 个
                  {verifiedAt ? ' · 已校验' : ''}
                </span>
              </div>

              <div className={styles.hint}>
                <b>列表可见 ≠ 当前可用</b>：`/models` 会列出账号可见但未开通/无权限的模型。
                导入前请点"校验可用性"逐个确认（每个发一次最小请求），再勾选要导入的模型——
                <b>只会导入你勾选的</b>。
              </div>

              <div className={styles.modelList}>
                {probe.models.slice(0, 120).map((m) => {
                  const on = selectedModels.some((x) => x.id === m.id);
                  const badge = badgeFor(m.id);
                  const detail = availability[m.id];
                  return (
                    <button
                      key={m.id}
                      className={`${styles.modelChip} ${on ? styles.modelOn : ''}`}
                      title={detail?.providerMessage ?? '点击勾选 / 取消勾选'}
                      onClick={() => toggleModel(m)}
                    >
                      <span className={styles.modelChipName}>{m.id}</span>
                      <span className={`${styles.tagBase} ${badge.cls}`}>{badge.text}</span>
                      {detail?.latencyMs != null && (
                        <span className={styles.tagMuted}>{detail.latencyMs}ms</span>
                      )}
                    </button>
                  );
                })}
              </div>

              {Object.values(availability).some((v) => v.status === 'unavailable') && (
                <div className={styles.warnBox}>
                  <AlertTriangle size={13} />
                  <div>
                    部分模型被判定为不可用（未开通 / 无权限 / 名称已下线），鼠标悬停可看供应商原话；
                    它们默认不会导入。
                  </div>
                </div>
              )}
            </>
          )}

          {!probe.ok && probe.hint && <div className={styles.warnBox}><AlertTriangle size={13} /><div>{probe.error}：{probe.hint}</div></div>}
        </div>
      )}

      <div className={styles.infoBox}>
        提示：<b>测试连接通过后再下一步</b>。该步骤会同时验证"能否列出模型"和"能否真正对话"，
        避免配好了却一直报 401。
      </div>
    </div>
  );
}

// ── 步骤 5：默认模型与路由 ──────────────────────────────────────────

function RoutingStep() {
  const { snapshot, routing, setRouting, toggleArbitrationModel } = useOnboardingStore();
  const models = snapshot?.models ?? [];
  const options = models.length > 0 ? models : [routing.defaultModel].filter(Boolean);
  const select = (label: string, key: keyof typeof routing, hint: string) => (
    <label className={styles.field}>
      <span>{label}<em className={styles.fieldHint}>{hint}</em></span>
      <select className={styles.select} value={String(routing[key])}
        onChange={(e) => setRouting({ [key]: e.target.value } as never)}>
        {options.map((m) => <option key={m} value={m}>{m}</option>)}
      </select>
    </label>
  );

  return (
    <div className={styles.stack}>
      {models.length === 0 && (
        <div className={styles.warnBox}>
          <AlertTriangle size={13} />
          <div>当前没有任何已注册模型：请回到上一步"测试连接"并注册供应商。</div>
        </div>
      )}
      <div className={styles.card}>
        <div className={styles.cardTitle}>角色与模型</div>
        {select('默认模型', 'defaultModel', '普通对话与兜底')}
        {select('规划模型', 'directorModel', '更强的模型做拆解与决策')}
        {select('执行模型', 'workerModel', '性价比更高的模型干活')}
        {select('校验模型', 'verifierModel', '独立模型做交叉校验')}
      </div>

      <div className={styles.card}>
        <div className={styles.cardTitle}>仲裁模型（至少 3 个）</div>
        <div className={styles.hint}>多智能体冲突时用于裁决；少于 3 个会导致后端启动校验失败。</div>
        <div className={styles.modelList}>
          {options.map((m) => {
            const on = routing.arbitrationModels.includes(m);
            return (
              <button key={m} className={`${styles.modelChip} ${on ? styles.modelOn : ''}`} onClick={() => toggleArbitrationModel(m)}>
                {m}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── 步骤 6：使用引导 ────────────────────────────────────────────────

function GuideStep() {
  const { paths, openPath } = useOnboardingStore();
  const items = [
    ['一次对话就是一支小队', 'Director 先拆解任务，Worker 执行，Verifier 交叉校验；工具调用、思考过程与耗时在对话里逐步可见。'],
    ['工作目录 = 工具的活动边界', '每个任务有独立工作目录（Workerspace），文件读写/命令执行都被限制在其中，越界会被拒绝。'],
    ['危险动作会先被拦下', 'L0 权限审查：删除、写系统路径、外部网络等动作会进入审批卡，确认后才执行；白名单可自动放行。'],
    ['Token 经济与预算', '每个任务有 token 预算，软/硬阈值会触发降级或停止；账本在「Token 账本」页可查。'],
    ['数据在哪、日志在哪', `数据根：${paths?.dataRoot ?? '—'}；日志：${paths?.logDir ?? '—'}；密钥：${paths?.secretsDir ?? '—'}（加密）。`],
    ['换模型 / 再加供应商', '设置 → 模型供应商；或重跑本引导（设置 → 重新运行初始化引导）。'],
  ];
  return (
    <div className={styles.stack}>
      <div className={styles.grid2}>
        {items.map(([title, body]) => (
          <div key={title} className={styles.card}>
            <div className={styles.cardTitle}>{title}</div>
            <p className={styles.hint}>{body}</p>
          </div>
        ))}
      </div>
      <div className={styles.row}>
        <button className={styles.ghostBtn} onClick={() => void openPath(paths?.dataRoot ?? '')}>
          <FolderOpen size={12} /> 打开数据目录
        </button>
        <button className={styles.ghostBtn} onClick={() => void openPath(paths?.logDir ?? '')}>
          <FolderOpen size={12} /> 打开日志目录
        </button>
      </div>
    </div>
  );
}

// ── 步骤 7：完成 ────────────────────────────────────────────────────

function DoneStep() {
  const { paths, routing, draft, personalization, snapshot } = useOnboardingStore();
  const rows: Array<[string, string]> = [
    ['供应商', draft.displayName || draft.providerId || '（未配置）'],
    ['默认模型', routing.defaultModel || '（未配置）'],
    ['校验模型', routing.verifierModel || '（未配置）'],
    ['日志级别', personalization.logLevel],
    ['数据根', paths?.dataRoot ?? '—'],
    ['工作空间', personalization.workspaceRoot || paths?.workspaceRoot || '—'],
    ['用户设置', paths?.userConfigPath ?? '—'],
  ];
  return (
    <div className={styles.stack}>
      <p className={styles.lead}>确认无误后点"开始使用"。所有设置写入用户配置层，**立即生效、无需重启**。</p>
      <div className={styles.card}>
        {rows.map(([k, v]) => (
          <div key={k} className={styles.summaryRow}>
            <span className={styles.summaryKey}>{k}</span>
            <span className={styles.summaryVal} title={v}>{v}</span>
          </div>
        ))}
      </div>
      {snapshot && snapshot.providers.length === 0 && (
        <div className={styles.warnBox}>
          <AlertTriangle size={13} />
          <div>还没有注册任何供应商：完成引导后仍可进入主界面，但**无法发起对话**。</div>
        </div>
      )}
    </div>
  );
}
