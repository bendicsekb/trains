import {
  TeachingSessionController,
} from "../src/teaching-session.mjs";

function completedPromptOptions(controller) {
  return (controller.state?.prompts ?? [])
    .filter((prompt) => ["published", "read_only"].includes(prompt.status))
    .map((prompt) => `${prompt.sequence}: ${prompt.prompt.replace(/\s+/g, " ").trim()} [${prompt.status}]`);
}

function optionSequence(option) {
  return option?.match(/^(\d+):/)?.[1];
}

function isControlInput(event) {
  return typeof event?.text === "string" && event.text.trim().startsWith("/");
}

export function createTeachingExtension(options = {}) {
  return function teachingExtension(pi) {
    const controller = new TeachingSessionController({
      notify: (message, level) => controller.ctx?.ui?.notify?.(message, level),
      ...options,
    });

    const attach = (ctx) => {
      controller.attachContext(ctx);
      return ctx;
    };

    pi.on("session_start", async (_event, ctx) => {
      attach(ctx);
      await controller.restore(ctx);
    });

    pi.on("before_agent_start", async (event, ctx) => {
      attach(ctx);
      if (!controller.state || !["active", "awaiting_rewrite"].includes(controller.state.status)) return;
      await controller.recordPrompt(event.prompt, ctx);
    });

    const settle = async (event, ctx) => {
      attach(ctx);
      await controller.settle(ctx, { willRetry: Boolean(event?.willRetry) });
    };

    // Current Pi exposes agent_end with a willRetry boundary. Newer runtimes
    // may also expose agent_settled; the controller makes the second signal
    // harmless when agent_end has already published the prompt.
    pi.on("agent_end", settle);
    pi.on("agent_settled", settle);

    pi.on("input", async (event, ctx) => {
      attach(ctx);
      if (isControlInput(event)) return { action: "continue" };
      if (!controller.state || !controller.state.status || controller.state.status === "ended") return { action: "continue" };
      if (controller.state.operation || controller.state.pendingPromptId || controller.state.status === "blocked") {
        ctx.ui.notify("Teaching is waiting for its current prompt or recovery operation; use /teach-resume-publication or wait for it to finish.", "warning");
        return { action: "handled" };
      }
      return { action: "continue" };
    });

    pi.on("session_before_tree", async (_event, ctx) => {
      attach(ctx);
      if (!controller.guardNativeNavigation()) return;
      ctx.ui.notify("Teaching sessions require /teach-rollback so code and evidence stay aligned; native tree navigation is blocked.", "warning");
      return { cancel: true };
    });

    pi.on("session_before_fork", async (_event, ctx) => {
      attach(ctx);
      if (!controller.guardNativeNavigation()) return;
      ctx.ui.notify("Teaching sessions require /teach-rollback; native fork/clone navigation is blocked.", "warning");
      return { cancel: true };
    });

    pi.registerCommand("teach-start", {
      description: "Start a Git-backed Pi teaching session",
      handler: async (_args, ctx) => {
        attach(ctx);
        await controller.start(ctx);
      },
    });

    pi.registerCommand("teach-status", {
      description: "Show the current teaching session and publication state",
      handler: async (_args, ctx) => {
        attach(ctx);
        if (!controller.state) await controller.restore(ctx);
        ctx.ui.notify(JSON.stringify(controller.status()), "info");
      },
    });

    pi.registerCommand("teach-rollback", {
      description: "Explain a failed prompt and restore code and conversation before it",
      handler: async (args, ctx) => {
        attach(ctx);
        if (!controller.state) await controller.restore(ctx);
        if (!ctx.isIdle()) {
          ctx.ui.notify("Rollback waits until the current Pi prompt has finished; nothing was changed.", "warning");
          return;
        }

        let identifier = args.trim().split(/\s+/).filter(Boolean)[0];
        if (!identifier) {
          const selected = await ctx.ui.select("Choose the prompt to rewrite", completedPromptOptions(controller));
          if (!selected) {
            ctx.ui.notify("Rollback cancelled; nothing was changed.", "info");
            return;
          }
          identifier = optionSequence(selected);
        }

        const explanation = await ctx.ui.editor(
          "Explain what went wrong (required)",
          "",
        );
        if (explanation === undefined) {
          ctx.ui.notify("Rollback cancelled; nothing was changed.", "info");
          return;
        }
        if (!explanation.trim()) {
          ctx.ui.notify("Rollback requires a nonblank explanation; nothing was changed.", "warning");
          return;
        }
        await controller.rollback(identifier, explanation, ctx);
      },
    });

    pi.registerCommand("teach-resume-publication", {
      description: "Resume an interrupted teaching publication or rollback",
      handler: async (_args, ctx) => {
        attach(ctx);
        if (!controller.state) await controller.restore(ctx);
        await controller.resume();
      },
    });

    pi.registerCommand("teach-end", {
      description: "End the current teaching session without deleting its branches or evidence",
      handler: async (_args, ctx) => {
        attach(ctx);
        if (!controller.state) await controller.restore(ctx);
        await controller.end();
      },
    });

    // Expose the controller for deterministic extension-host tests without
    // adding any Pi-visible conversation content.
    pi.teachingSessionController = controller;
  };
}

export default createTeachingExtension();
