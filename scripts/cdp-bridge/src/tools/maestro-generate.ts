import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolResult } from '../utils.js';
import { okResult, failResult } from '../utils.js';
import { findProjectRoot } from '../nav-graph/storage.js';

interface MaestroStep {
  action: 'tap' | 'fill' | 'assert' | 'scroll' | 'navigate' | 'back' | 'wait' | 'swipe' | 'launch';
  testID?: string;
  text?: string;
  input?: string;
  direction?: 'up' | 'down' | 'left' | 'right';
  url?: string;
  waitMs?: number;
}

interface MaestroGenerateArgs {
  name: string;
  steps: MaestroStep[];
  appId?: string;
  outputDir?: string;
}

function stepToYaml(step: MaestroStep): string {
  switch (step.action) {
    case 'launch':
      return '- launchApp';

    case 'tap':
      if (step.testID) return `- tapOn:\n    id: "${step.testID}"`;
      if (step.text) return `- tapOn: "${step.text}"`;
      return '# tap: missing testID or text';

    case 'fill':
      if (step.testID && step.input !== undefined) {
        return `- tapOn:\n    id: "${step.testID}"\n- inputText: "${step.input}"`;
      }
      if (step.text && step.input !== undefined) {
        return `- tapOn: "${step.text}"\n- inputText: "${step.input}"`;
      }
      return '# fill: missing testID/text or input';

    case 'assert':
      if (step.testID) return `- assertVisible:\n    id: "${step.testID}"`;
      if (step.text) return `- assertVisible: "${step.text}"`;
      return '# assert: missing testID or text';

    case 'scroll':
      return `- scroll`;

    case 'swipe':
      if (step.direction) return `- swipe:\n    direction: "${step.direction.toUpperCase()}"`;
      return '- swipe:\n    direction: "UP"';

    case 'navigate':
      if (step.url) return `- openLink: "${step.url}"`;
      return '# navigate: missing url';

    case 'back':
      return '- pressKey: back';

    case 'wait':
      if (step.waitMs) return `- extendedWaitUntil:\n    visible: ".*"\n    timeout: ${step.waitMs}`;
      return '# wait: use waitMs parameter';

    default:
      return `# unknown action: ${step.action}`;
  }
}

export function createMaestroGenerateHandler(): (args: MaestroGenerateArgs) => Promise<ToolResult> {
  return async (args) => {
    if (!args.name || !args.steps?.length) {
      return failResult('Provide a flow name and at least one step.');
    }

    const root = findProjectRoot();
    const outputDir = args.outputDir ?? (root ? join(root, '.maestro', 'flows') : null);
    if (!outputDir) {
      return failResult('Cannot determine project root. Pass outputDir explicitly.');
    }

    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }

    const sanitizedName = args.name.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
    const fileName = `${sanitizedName}.yaml`;
    const filePath = join(outputDir, fileName);

    const lines: string[] = [];

    if (args.appId) {
      lines.push(`appId: ${args.appId}`);
      lines.push('---');
    }

    for (const step of args.steps) {
      lines.push(stepToYaml(step));
    }

    const content = lines.join('\n') + '\n';
    writeFileSync(filePath, content, 'utf-8');

    return okResult({
      generated: true,
      path: filePath,
      name: fileName,
      stepCount: args.steps.length,
    });
  };
}
