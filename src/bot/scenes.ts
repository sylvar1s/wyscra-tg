import { compose, type Handler, type Middleware } from './composer.js';
import { MESSAGE_UPDATES, type Context } from './context.js';

interface SceneState {
  id: string;
  step: number;
  data: Record<string, any>;
  /** last activity, ms */
  at: number;
}

const KEY = '__scene';

export interface SceneOptions {
  /** Leave the scene automatically after this many ms without activity. Default: never. */
  ttl?: number;
  /** Let the current step receive /commands too. Default: false (commands go to normal handlers, so /cancel works). */
  handleCommands?: boolean;
}

/**
 * Multi-step dialog whose position is stored in the session, so it survives restarts
 * when the session store is persistent.
 * ```ts
 * const signup = new Scene('signup')
 *   .step(ctx => ctx.reply('Your name?'))
 *   .step(ctx => { ctx.scene.data.name = ctx.text; return ctx.reply('Your age?'); })
 *   .step(async ctx => {
 *     if (!/^\d+$/.test(ctx.text ?? '')) return (ctx.scene.stay(), ctx.reply('Digits please'));
 *     await ctx.reply(`Saved: ${ctx.scene.data.name}, ${ctx.text}`);
 *   });
 * bot.use(session(), scenes(signup));
 * bot.command('signup', ctx => ctx.scene.enter('signup'));
 * ```
 */
export class Scene<C extends Context = Context> {
  readonly steps: Middleware<C>[] = [];
  private leaveHandler?: Middleware<C>;

  constructor(
    readonly id: string,
    readonly options: SceneOptions = {},
  ) {}

  /** Adds a step. The first step runs on enter; each next one gets the following message/button press. */
  step(...handlers: Handler<C>[]): this {
    this.steps.push(compose(handlers as Middleware<C>[]));
    return this;
  }

  /** Runs when the scene is left (finished, `leave()`, or TTL expired). */
  onLeave(handler: Handler<C>): this {
    this.leaveHandler = handler as Middleware<C>;
    return this;
  }

  /** @internal */
  async runLeave(ctx: C): Promise<void> {
    if (this.leaveHandler) await this.leaveHandler(ctx, async () => {});
  }
}

/** `ctx.scene`: control of the current scene. */
export class SceneControl {
  /** @internal */ _moved = false;

  constructor(
    private readonly ctx: Context,
    private readonly registry: Map<string, Scene<any>>,
  ) {}

  private get state(): SceneState | undefined {
    return this.ctx.session?.[KEY];
  }
  private set state(v: SceneState | undefined) {
    if (!this.ctx.session) throw new Error('Scenes need the session middleware: bot.use(session(), scenes(...))');
    if (v) this.ctx.session[KEY] = v;
    else delete this.ctx.session[KEY];
  }

  /** Id of the active scene, if any. */
  get current(): string | undefined {
    return this.state?.id;
  }
  /** Index of the step that will handle the next update. */
  get step(): number {
    return this.state?.step ?? 0;
  }
  /** Data persisted for the duration of the scene (must be JSON-serializable). */
  get data(): Record<string, any> {
    const s = this.state;
    if (!s) throw new Error('Not in a scene');
    return s.data;
  }

  /** Enters a scene and runs its first step right away. */
  async enter(id: string, data: Record<string, any> = {}): Promise<void> {
    const scene = this.registry.get(id);
    if (!scene) throw new Error(`Unknown scene "${id}"`);
    this.state = { id, step: 0, data, at: Date.now() };
    await runStep(this.ctx, scene, this);
  }

  /** Leaves the current scene. */
  async leave(): Promise<void> {
    const s = this.state;
    if (!s) return;
    this.state = undefined;
    this._moved = true;
    await this.registry.get(s.id)?.runLeave(this.ctx);
  }

  /** Repeat the current step on the next update (e.g. invalid input). */
  stay(): void {
    this._moved = true;
  }
  /** Jump to a step index (it handles the next update). */
  goto(step: number): void {
    const s = this.state;
    if (!s) throw new Error('Not in a scene');
    s.step = step;
    this._moved = true;
  }
  back(): void {
    this.goto(Math.max(0, this.step - 1));
  }
}

async function runStep(ctx: Context, scene: Scene<any>, ctl: SceneControl): Promise<void> {
  const state = ctx.session[KEY] as SceneState;
  const handler = scene.steps[state.step];
  if (!handler) return ctl.leave();
  ctl._moved = false;
  await handler(ctx, async () => {});
  const after = ctx.session?.[KEY] as SceneState | undefined;
  if (!after || after !== state || ctl._moved) return; // left, re-entered or moved explicitly
  state.step++;
  state.at = Date.now();
  if (state.step >= scene.steps.length) await ctl.leave();
}

const STEP_UPDATES = new Set<string>([...MESSAGE_UPDATES.filter((t) => !t.startsWith('edited')), 'callback_query']);

/** Registers scenes and adds `ctx.scene`. Must come after `session()`. */
export function scenes<C extends Context = Context>(...list: Scene<C>[]): Middleware<C> {
  const registry = new Map<string, Scene<any>>(list.map((s) => [s.id, s]));
  return async (ctx, next) => {
    const ctl = new SceneControl(ctx, registry);
    (ctx as Context).scene = ctl;
    const state = ctx.session?.[KEY] as SceneState | undefined;
    if (!state) return next();
    const scene = registry.get(state.id);
    if (!scene) {
      delete ctx.session[KEY];
      return next();
    }
    if (scene.options.ttl && Date.now() - state.at > scene.options.ttl) {
      await ctl.leave();
      return next();
    }
    if (!STEP_UPDATES.has(ctx.updateType) || (ctx.command && !scene.options.handleCommands)) return next();
    await runStep(ctx, scene, ctl);
  };
}
