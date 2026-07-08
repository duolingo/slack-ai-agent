import { bindUserToMcpServers, McpServerConfig } from "./mcp-manager";

describe("bindUserToMcpServers", () => {
  const identityBound: McpServerConfig = {
    type: "http",
    url: "https://identity-service.example.com/mcp",
    headers: { AUTH_TOKEN: "static-token" },
    userEmailHeader: "X-User-Email",
  };
  const plainHttp: McpServerConfig = {
    type: "http",
    url: "https://plain-service.example.com/mcp",
    headers: { AUTH_TOKEN: "static-token" },
  };
  const stdio: McpServerConfig = {
    command: "npx",
    args: ["-y", "some-mcp-server"],
  };

  it("injects the email under the declared header and strips the marker", () => {
    const { servers, omitted } = bindUserToMcpServers(
      { identity: identityBound },
      "user@example.com",
    );

    expect(omitted).toEqual([]);
    expect(servers.identity).toEqual({
      type: "http",
      url: "https://identity-service.example.com/mcp",
      headers: {
        AUTH_TOKEN: "static-token",
        "X-User-Email": "user@example.com",
      },
    });
    expect(servers.identity).not.toHaveProperty("userEmailHeader");
  });

  it("omits identity-bound servers when no email is resolvable", () => {
    const { servers, omitted } = bindUserToMcpServers(
      { identity: identityBound, plain: plainHttp },
      undefined,
    );

    expect(omitted).toEqual(["identity"]);
    expect(servers).not.toHaveProperty("identity");
    expect(servers.plain).toBe(plainHttp);
  });

  it("passes through servers without userEmailHeader unchanged", () => {
    const { servers, omitted } = bindUserToMcpServers(
      { plain: plainHttp, local: stdio },
      "user@example.com",
    );

    expect(omitted).toEqual([]);
    expect(servers.plain).toBe(plainHttp);
    expect(servers.local).toBe(stdio);
  });

  it("does not mutate the shared input config", () => {
    const input = { identity: identityBound };
    bindUserToMcpServers(input, "user@example.com");

    expect(input.identity.headers).toEqual({ AUTH_TOKEN: "static-token" });
    expect(input.identity.userEmailHeader).toBe("X-User-Email");
  });

  it("treats a blank userEmailHeader as not identity-bound", () => {
    const blank: McpServerConfig = {
      type: "http",
      url: "https://blank.example.com/mcp",
      userEmailHeader: "   ",
    };
    const { servers, omitted } = bindUserToMcpServers({ blank }, undefined);

    expect(omitted).toEqual([]);
    expect(servers.blank).toBe(blank);
  });

  it("binds sse servers the same way as http servers", () => {
    const sse: McpServerConfig = {
      type: "sse",
      url: "https://sse.example.com/sse",
      userEmailHeader: "X-User-Email",
    };
    const { servers } = bindUserToMcpServers({ sse }, "user@example.com");

    expect(servers.sse).toEqual({
      type: "sse",
      url: "https://sse.example.com/sse",
      headers: { "X-User-Email": "user@example.com" },
    });
  });
});
