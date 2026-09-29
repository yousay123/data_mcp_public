package com.ksher.agentdatamcp.client;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "ksher.data-mcp")
public record DataMcpProperties(
    String pythonBaseUrl,
    long requestTimeoutMs,
    String internalAuthToken
) {
}
