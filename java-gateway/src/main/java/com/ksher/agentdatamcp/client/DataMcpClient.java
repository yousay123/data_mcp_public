package com.ksher.agentdatamcp.client;

import java.util.Map;

import org.springframework.http.HttpHeaders;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.client.WebClient;
import reactor.core.publisher.Mono;

@Component
public class DataMcpClient {
    private final WebClient webClient;
    private final DataMcpProperties properties;

    public DataMcpClient(WebClient dataMcpWebClient, DataMcpProperties properties) {
        this.webClient = dataMcpWebClient;
        this.properties = properties;
    }

    public Mono<Map> post(String path, Object request) {
        return webClient.post()
            .uri(path)
            .headers(this::addInternalAuthHeader)
            .bodyValue(request)
            .retrieve()
            .bodyToMono(Map.class);
    }

    private void addInternalAuthHeader(HttpHeaders headers) {
        String token = properties.internalAuthToken();
        if (token != null && !token.isBlank()) {
            headers.set("X-Internal-Auth", token);
        }
    }
}
