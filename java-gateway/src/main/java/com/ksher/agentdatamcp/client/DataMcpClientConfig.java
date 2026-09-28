package com.ksher.agentdatamcp.client;

import java.time.Duration;

import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.client.reactive.ReactorClientHttpConnector;
import org.springframework.web.reactive.function.client.WebClient;
import reactor.netty.http.client.HttpClient;

@Configuration
@EnableConfigurationProperties(DataMcpProperties.class)
public class DataMcpClientConfig {
    @Bean
    WebClient dataMcpWebClient(DataMcpProperties properties) {
        HttpClient httpClient = HttpClient.create()
            .responseTimeout(Duration.ofMillis(properties.requestTimeoutMs()));
        return WebClient.builder()
            .baseUrl(properties.pythonBaseUrl())
            .clientConnector(new ReactorClientHttpConnector(httpClient))
            .build();
    }
}
