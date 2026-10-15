/**
 * P0-2 验收：桌面外联 URL 策略（REV-148/286/287）
 *
 * `electron/urlPolicy.ts` 不依赖 electron 运行时，可直接在 Node 测试环境覆盖。
 * 这里锁住三条红线：
 *  1. 交给外部程序的链接只认 https/mailto（`file:`、`ms-msdt:` 等一律拒）；
 *  2. `server-fetch` 只能打本机后端端口或**已固定的账号服务端**（否则就是内网代理）；
 *  3. 账号服务端 origin 的固定入口本身也要被校验。
 */
import { describe, expect, it } from "vitest";

import {
  isSafeExternalUrl,
  isAllowedServerFetchTarget,
  normalizeAccountOrigin,
} from "../../electron/urlPolicy.js";

describe("isSafeExternalUrl（setWindowOpenHandler 与 open-external 共用）", () => {
  it.each(["https://example.com/docs", "mailto:someone@example.com"])(
    "放行 %s",
    (url) => {
      expect(isSafeExternalUrl(url).allowed).toBe(true);
    },
  );

  it.each([
    "http://example.com",
    "file:///C:/Windows/system32/calc.exe",
    "javascript:alert(1)",
    "ms-msdt:/id bugCd...",
    "search-ms:query=x",
    "",
    "not a url",
    null,
    42,
  ])("拒绝 %o", (url) => {
    const decision = isSafeExternalUrl(url);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBeTruthy();
  });
});

describe("isAllowedServerFetchTarget（server-fetch 不是内网代理）", () => {
  const allowance = {
    localHttpPort: 3000,
    accountOrigin: null as string | null,
  };

  it("本机后端端口放行", () => {
    expect(
      isAllowedServerFetchTarget(
        "http://127.0.0.1:3000/api/sessions",
        allowance,
      ).allowed,
    ).toBe(true);
    expect(
      isAllowedServerFetchTarget(
        "http://localhost:3000/api/sessions",
        allowance,
      ).allowed,
    ).toBe(true);
  });

  it("回环上的其他端口未经固定一律拒绝（含链路本地元数据地址）", () => {
    expect(
      isAllowedServerFetchTarget("http://127.0.0.1:8787/v1/login", allowance)
        .allowed,
    ).toBe(false);
    expect(
      isAllowedServerFetchTarget(
        "http://169.254.169.254/latest/meta-data/",
        allowance,
      ).allowed,
    ).toBe(false);
    expect(
      isAllowedServerFetchTarget("http://192.168.1.1/admin", allowance).allowed,
    ).toBe(false);
  });

  it("后端端口未知（尚未就绪）时本机请求也不放行", () => {
    const decision = isAllowedServerFetchTarget(
      "http://127.0.0.1:3000/api/sessions",
      { ...allowance, localHttpPort: null },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("尚未就绪");
  });

  it("固定账号服务端后：该 origin 放行，同回环其他端口仍拒", () => {
    const pinned = {
      localHttpPort: 3000,
      accountOrigin: "http://127.0.0.1:8787",
    };
    expect(
      isAllowedServerFetchTarget("http://127.0.0.1:8787/v1/login", pinned)
        .allowed,
    ).toBe(true);
    expect(
      isAllowedServerFetchTarget("http://127.0.0.1:9999/v1/login", pinned)
        .allowed,
    ).toBe(false);
  });

  it("非回环账号服务端必须是 https，且必须与固定 origin 完全一致", () => {
    const pinned = {
      localHttpPort: 3000,
      accountOrigin: "https://account.example.com",
    };
    expect(
      isAllowedServerFetchTarget("https://account.example.com/v1/login", pinned)
        .allowed,
    ).toBe(true);
    expect(
      isAllowedServerFetchTarget("http://account.example.com/v1/login", pinned)
        .allowed,
    ).toBe(false);
    expect(
      isAllowedServerFetchTarget("https://evil.example.com/v1/login", pinned)
        .allowed,
    ).toBe(false);
    expect(
      isAllowedServerFetchTarget(
        "https://account.example.com.evil.example.com/",
        pinned,
      ).allowed,
    ).toBe(false);
  });

  it("非 http(s) 的 scheme 一律拒绝", () => {
    expect(
      isAllowedServerFetchTarget("file:///C:/secret.json", allowance).allowed,
    ).toBe(false);
    expect(
      isAllowedServerFetchTarget("gopher://127.0.0.1:25/", allowance).allowed,
    ).toBe(false);
    expect(isAllowedServerFetchTarget(undefined, allowance).allowed).toBe(
      false,
    );
  });
});

describe("normalizeAccountOrigin（固定入口自身的校验）", () => {
  it("接受 https 与回环 http 的纯 origin，并归一化", () => {
    expect(normalizeAccountOrigin("https://account.example.com")).toEqual({
      allowed: true,
      origin: "https://account.example.com",
    });
    expect(normalizeAccountOrigin("http://127.0.0.1:8787/")).toEqual({
      allowed: true,
      origin: "http://127.0.0.1:8787",
    });
  });

  it("拒绝明文 http 的非回环地址、带路径的地址与非法输入", () => {
    expect(normalizeAccountOrigin("http://192.168.1.10:8787").allowed).toBe(
      false,
    );
    expect(
      normalizeAccountOrigin("https://account.example.com/api/v1").allowed,
    ).toBe(false);
    expect(normalizeAccountOrigin("account.example.com").allowed).toBe(false);
    expect(normalizeAccountOrigin("").allowed).toBe(false);
    expect(normalizeAccountOrigin({}).allowed).toBe(false);
  });
});
