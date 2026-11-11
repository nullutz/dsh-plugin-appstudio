import { runtimeIssues, type RuntimeIssue } from '../shared/protocol.ts';

export class RuntimeProblem extends Error {
  constructor(readonly issue: RuntimeIssue, message: string) {
    super(message);
  }
}

export function runtimeIssue(value: unknown): RuntimeIssue | undefined {
  return runtimeIssues.find(issue => issue === value);
}

export function hostPrerequisite(issue: RuntimeIssue | undefined): boolean {
  return issue === 'wsl-unavailable' || issue === 'wsl-kernel' || issue === 'wsl-virtualization';
}

export function diagnosticIssue(output: string): RuntimeIssue | undefined {
  const text = output.replace(/[\0\uFEFF]/gu, '');
  const markers = [...text.matchAll(/^APPSTUDIO_RUNTIME_ERROR ([a-z-]+)\s*$/gmu)];
  const reported = runtimeIssue(markers.at(-1)?.[1]);
  if (reported) return reported;
  if (/HCS_E_HYPERV_NOT_INSTALLED|HCS_E_HYPERV_NOT_ENABLED|0x80370102|0x80370114/iu.test(text)) return 'wsl-virtualization';
  if (/WSL_E_WSL_OPTIONAL_COMPONENT_REQUIRED|0x8007019e/iu.test(text)) return 'wsl-unavailable';
  if (/WSL_E_WSL2_KERNEL_FILE_NOT_FOUND|0x800701bc/iu.test(text)) return 'wsl-kernel';
  if (/WSL_E_DISTRO_NOT_FOUND/iu.test(text)) return 'runtime-missing';
  if (/0x80070070|0x80070005|\b(?:ENOSPC|EACCES)\b|no space left on device/iu.test(text)) return 'runtime-storage';
  return undefined;
}

export function safeRuntimeOutput(output: string): string {
  return output.replace(/[\0\uFEFF]/gu, '')
    .replace(/^APPSTUDIO_RUNTIME_ERROR [a-z-]+\s*$/gmu, '')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/giu, '$1[redacted]@')
    .replace(/(\bBearer\s+)[\w.+/=-]+/giu, '$1[redacted]')
    .replace(/("(?:token|password|secret)"\s*:\s*")[^"]+"/giu, '$1[redacted]"')
    .replace(/([?&](?:access[_-]?token|token|api[_-]?key|password)=)[^&\s"']+/giu, '$1[redacted]')
    .replace(/\b(?:gh[pousr]_[a-z0-9]{30,}|github_pat_[a-z0-9_]{35,}|sk-[a-z0-9_-]{28,})\b/giu, '[redacted]')
    .replace(/([A-Z]:[\\/]Users[\\/]|\/mnt\/[a-z]\/Users\/)[^\\/\r\n"']+/giu, '$1[redacted]')
    .trim()
    .slice(-1400);
}
