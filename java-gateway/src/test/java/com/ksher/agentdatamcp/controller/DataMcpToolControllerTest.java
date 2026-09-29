package com.ksher.agentdatamcp.controller;

import static org.assertj.core.api.Assertions.assertThat;
import static java.util.Map.entry;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.ksher.agentdatamcp.client.DataMcpClient;
import com.ksher.agentdatamcp.client.DataMcpProperties;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.reactive.WebFluxTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.context.annotation.Bean;
import org.springframework.http.MediaType;
import org.springframework.test.web.reactive.server.WebTestClient;
import reactor.core.publisher.Mono;

@WebFluxTest(DataMcpToolController.class)
class DataMcpToolControllerTest {
    @Autowired
    private WebTestClient webClient;

    @MockBean
    private DataMcpClient dataMcpClient;

    @Test
    void exportEndpointForwardsSnakeCasePayloadToPythonService() {
        when(dataMcpClient.post(eq("/agent/export-query-excel-file"), org.mockito.ArgumentMatchers.any()))
            .thenReturn(Mono.just(Map.of("status", "success")));

        webClient.post()
            .uri("/api/data-mcp/agent/export-query-excel-file")
            .header("X-Internal-Auth", "expected-token")
            .contentType(MediaType.APPLICATION_JSON)
            .bodyValue(
                """
                {
                  "requestUserUnionId": "on_example",
                  "requestUserOpenId": "ou_example",
                  "requestLarkAppId": "cli_example",
                  "callerSource": "schedule_creator",
                  "callerSenderType": "bot",
                  "callerSessionId": "session_123",
                  "callerTaskId": "task_123",
                  "callerTurnId": "turn_123",
                  "callerCapturedAt": "2026-09-01T10:00:00Z",
                  "sql": "SELECT 1",
                  "datasource": "tchouse-c",
                  "queryPlanId": "qplan_123",
                  "filename": "result.xlsx",
                  "maxExportRows": 50
                }
                """
            )
            .exchange()
            .expectStatus().isOk()
            .expectBody()
            .jsonPath("$.status").isEqualTo("success");

        ArgumentCaptor<Object> payloadCaptor = ArgumentCaptor.forClass(Object.class);
        verify(dataMcpClient).post(eq("/agent/export-query-excel-file"), payloadCaptor.capture());

        assertThat(payloadCaptor.getValue()).isEqualTo(
            Map.ofEntries(
                entry("request_user_union_id", "on_example"),
                entry("request_user_open_id", "ou_example"),
                entry("request_lark_app_id", "cli_example"),
                entry("caller_source", "schedule_creator"),
                entry("caller_sender_type", "bot"),
                entry("caller_session_id", "session_123"),
                entry("caller_task_id", "task_123"),
                entry("caller_turn_id", "turn_123"),
                entry("caller_captured_at", "2026-09-01T10:00:00Z"),
                entry("sql", "SELECT 1"),
                entry("datasource", "tchouse-c"),
                entry("query_plan_id", "qplan_123"),
                entry("filename", "result.xlsx"),
                entry("max_export_rows", 50)
            )
        );
    }

    @Test
    void validateAndRunForwardDifferentPlanContracts() {
        when(dataMcpClient.post(eq("/agent/validate-sql"), org.mockito.ArgumentMatchers.any()))
            .thenReturn(Mono.just(Map.of("status", "success")));
        when(dataMcpClient.post(eq("/agent/run-query"), org.mockito.ArgumentMatchers.any()))
            .thenReturn(Mono.just(Map.of("status", "success")));

        String common = """
            {
              "requestUserUnionId": "on_example",
              "requestLarkAppId": "cli_example",
              "callerSenderType": "user",
              "callerSessionId": "session_123",
              "sql": "SELECT 1",
              "datasource": "tchouse-c",
              %s
            }
            """;
        webClient.post()
            .uri("/api/data-mcp/agent/validate-sql")
            .header("X-Internal-Auth", "expected-token")
            .contentType(MediaType.APPLICATION_JSON)
            .bodyValue(common.formatted("\"executionMode\": \"compare\""))
            .exchange()
            .expectStatus().isOk();
        webClient.post()
            .uri("/api/data-mcp/agent/run-query")
            .header("X-Internal-Auth", "expected-token")
            .contentType(MediaType.APPLICATION_JSON)
            .bodyValue(common.formatted("\"queryPlanId\": \"qplan_123\""))
            .exchange()
            .expectStatus().isOk();

        ArgumentCaptor<Object> validatePayload = ArgumentCaptor.forClass(Object.class);
        ArgumentCaptor<Object> runPayload = ArgumentCaptor.forClass(Object.class);
        verify(dataMcpClient).post(eq("/agent/validate-sql"), validatePayload.capture());
        verify(dataMcpClient).post(eq("/agent/run-query"), runPayload.capture());
        Map<?, ?> validateMap = (Map<?, ?>) validatePayload.getValue();
        Map<?, ?> runMap = (Map<?, ?>) runPayload.getValue();
        assertThat(validateMap.get("execution_mode")).isEqualTo("compare");
        assertThat(validateMap.containsKey("query_plan_id")).isFalse();
        assertThat(runMap.get("caller_session_id")).isEqualTo("session_123");
        assertThat(runMap.get("query_plan_id")).isEqualTo("qplan_123");
        assertThat(runMap.containsKey("execution_mode")).isFalse();
    }

    @Test
    void exportEndpointRejectsInvalidInternalAuth() {
        webClient.post()
            .uri("/api/data-mcp/agent/export-query-excel-file")
            .header("X-Internal-Auth", "wrong-token")
            .contentType(MediaType.APPLICATION_JSON)
            .bodyValue(
                """
                {
                  "requestUserUnionId": "on_example",
                  "sql": "SELECT 1"
                }
                """
            )
            .exchange()
            .expectStatus().isUnauthorized();
    }

    @TestConfiguration
    static class TestConfig {
        @Bean
        DataMcpProperties dataMcpProperties() {
            return new DataMcpProperties(
                "http://127.0.0.1:8765",
                5000,
                "expected-token"
            );
        }
    }
}
