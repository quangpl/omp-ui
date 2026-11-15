import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type CommandRunner, openFirewallPort } from "@/lib/cluster/firewall";

type Result = { code: number; stdout: string; stderr: string };

const OK: Result = { code: 0, stdout: "", stderr: "" };
const MISSING: Result = { code: 127, stdout: "", stderr: "command not found" };
const UFW_ACTIVE = "Status: active\n\nTo                         Action      From\n--                         ------      ----\n22/tcp                     ALLOW       Anywhere\n";

const savedPlatform = Object.getOwnPropertyDescriptor(process, "platform");

/** A runner answering by the full command line ("sudo -n ufw status"); unknown commands are not installed. */
function fakeRunner(answers: Record<string, Partial<Result>>): { run: CommandRunner; calls: string[] } {
  const calls: string[] = [];
  const run: CommandRunner = async (cmd, args) => {
    const line = [cmd, ...args].join(" ");
    calls.push(line);
    const answer = answers[line];
    return answer ? { ...OK, ...answer } : MISSING;
  };
  return { run, calls };
}

beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "linux" });
  vi.spyOn(process, "getuid").mockReturnValue(1000);
});

afterEach(() => {
  if (savedPlatform) Object.defineProperty(process, "platform", savedPlatform);
  vi.restoreAllMocks();
});

describe("openFirewallPort", () => {
  it("allows the port in an active ufw through sudo -n when not root", async () => {
    const { run, calls } = fakeRunner({
      "sudo -n true": OK,
      "sudo -n ufw status": { stdout: UFW_ACTIVE },
      "sudo -n ufw allow 7790/tcp comment omp-ui cluster": { stdout: "Rule added" },
    });
    const result = await openFirewallPort(7790, run);
    expect(result).toMatchObject({ tool: "ufw", changed: true, ok: true });
    expect(calls).toContain("sudo -n ufw allow 7790/tcp comment omp-ui cluster");
  });

  it("runs the commands directly as root", async () => {
    vi.spyOn(process, "getuid").mockReturnValue(0);
    const { run, calls } = fakeRunner({
      "ufw status": { stdout: UFW_ACTIVE },
      "ufw allow 7790/tcp comment omp-ui cluster": { stdout: "Rule added" },
    });
    const result = await openFirewallPort(7790, run);
    expect(result).toMatchObject({ tool: "ufw", changed: true, ok: true });
    expect(calls).not.toContain("sudo -n true");
    expect(calls).toContain("ufw allow 7790/tcp comment omp-ui cluster");
  });

  it("leaves ufw unchanged when the port is already allowed", async () => {
    const { run, calls } = fakeRunner({
      "sudo -n true": OK,
      "sudo -n ufw status": {
        stdout: `${UFW_ACTIVE}7790/tcp                   ALLOW       Anywhere                   # omp-ui cluster\n`,
      },
    });
    const result = await openFirewallPort(7790, run);
    expect(result).toMatchObject({ tool: "ufw", changed: false, ok: true });
    expect(calls.some((c) => c.includes("allow"))).toBe(false);
  });

  it("does not mistake another port's rule for the cluster port", async () => {
    const { run, calls } = fakeRunner({
      "sudo -n true": OK,
      "sudo -n ufw status": { stdout: `${UFW_ACTIVE}17790/tcp                  ALLOW       Anywhere\n` },
      "sudo -n ufw allow 7790/tcp comment omp-ui cluster": { stdout: "Rule added" },
    });
    const result = await openFirewallPort(7790, run);
    expect(result).toMatchObject({ tool: "ufw", changed: true, ok: true });
    expect(calls).toContain("sudo -n ufw allow 7790/tcp comment omp-ui cluster");
  });

  it("adds the port to a running firewalld (runtime and permanent)", async () => {
    const { run, calls } = fakeRunner({
      "sudo -n true": OK,
      "sudo -n firewall-cmd --state": { stdout: "running\n" },
      "sudo -n firewall-cmd --query-port=7790/tcp": { code: 1, stdout: "no\n" },
      "sudo -n firewall-cmd --add-port=7790/tcp": { stdout: "success\n" },
      "sudo -n firewall-cmd --permanent --add-port=7790/tcp": { stdout: "success\n" },
    });
    const result = await openFirewallPort(7790, run);
    expect(result).toMatchObject({ tool: "firewalld", changed: true, ok: true });
    expect(calls).toContain("sudo -n firewall-cmd --add-port=7790/tcp");
    expect(calls).toContain("sudo -n firewall-cmd --permanent --add-port=7790/tcp");
  });

  it("does nothing when no firewall is active", async () => {
    const { run, calls } = fakeRunner({
      "sudo -n true": OK,
      "sudo -n ufw status": { stdout: "Status: inactive\n" },
      "sudo -n firewall-cmd --state": { code: 252, stdout: "not running\n" },
    });
    const result = await openFirewallPort(7790, run);
    expect(result).toEqual({ tool: null, changed: false, ok: true, message: expect.any(String) });
    expect(calls.some((c) => c.includes("allow") || c.includes("--add-port"))).toBe(false);
  });

  it("names the command to run when sudo needs a password", async () => {
    const { run, calls } = fakeRunner({
      "sudo -n true": { code: 1, stderr: "sudo: a password is required" },
      "grep -Eqs ^[[:space:]]*ENABLED[[:space:]]*=[[:space:]]*yes /etc/ufw/ufw.conf": OK,
    });
    const result = await openFirewallPort(7790, run);
    expect(result.ok).toBe(false);
    expect(result.tool).toBe("ufw");
    expect(result.message).toContain("sudo ufw allow 7790/tcp comment 'omp-ui cluster'");
    expect(calls.some((c) => c.startsWith("sudo -n ufw"))).toBe(false);
  });

  it("reports a failing command with the command to run", async () => {
    const { run } = fakeRunner({
      "sudo -n true": OK,
      "sudo -n ufw status": { stdout: UFW_ACTIVE },
      "sudo -n ufw allow 7790/tcp comment omp-ui cluster": { code: 1, stderr: "ERROR: problem running iptables" },
    });
    const result = await openFirewallPort(7790, run);
    expect(result).toMatchObject({ tool: "ufw", changed: false, ok: false });
    expect(result.message).toContain("sudo ufw allow 7790/tcp comment 'omp-ui cluster'");
  });

  it("does nothing outside Linux", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    const { run, calls } = fakeRunner({});
    const result = await openFirewallPort(7790, run);
    expect(result).toMatchObject({ tool: null, changed: false, ok: true });
    expect(calls).toEqual([]);
  });
});
