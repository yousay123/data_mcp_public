package com.ksher.agentdatamcp.controller;

import com.ksher.agentdatamcp.client.DataMcpClient;
import com.ksher.agentdatamcp.client.DataMcpProperties;
import com.ksher.agentdatamcp.dto.ToolRequests.AgentExportRequest;
import com.ksher.agentdatamcp.dto.ToolRequests.AgentSqlRequest;
import jakarta.validation.Valid;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;
import reactor.core.publisher.Mono;

@RestController
@RequestMapping("/api/data-mcp")
public class DataMcpToolController {
    private static final String INTERNAL_AUTH_HEADER = "X-Internal-Auth";

    private final DataMcpClient client;
    private final DataMcpProperties properties;

    public DataMcpToolController(DataMcpClient client, DataMcpProperties properties) {
        this.client = client;
        this.properties = properties;
    }

    @PostMapping("/agent/validate-sql")
    public Mono<Map> agentValidateSql(
        @RequestHeader(value = INTERNAL_AUTH_HEADER, required = false) String internalAuth,
        @Valid @RequestBody AgentSqlRequest request
    ) {
        requireInternalAuth(internalAuth);
        return client.post(
            "/agent/validate-sql",
            toPythonValidationRequest(request)
        );
    }

    @PostMapping("/agent/run-query")
    public Mono<Map> agentRunQuery(
        @RequestHeader(value = INTERNAL_AUTH_HEADER, required = false) String internalAuth,
        @Valid @RequestBody AgentSqlRequest request
    ) {
        requireInternalAuth(internalAuth);
        return client.post(
            "/agent/run-query",
            toPythonExecutionRequest(request)
        );
    }

    @PostMapping("/agent/export-query-excel-file")
    public Mono<Map> agentExportQueryExcelFile(
        @RequestHeader(value = INTERNAL_AUTH_HEADER, required = false) String internalAuth,
        @Valid @RequestBody AgentExportRequest request
    ) {
        requireInternalAuth(internalAuth);
        return client.post(
            "/agent/export-query-excel-file",
            toPythonExportRequest(request)
        );
    }

    private void requireInternalAuth(String internalAuth) {
        String expected = properties.internalAuthToken();
        if (expected == null || expected.isBlank()) {
            throw new ResponseStatusException(
                HttpStatus.SERVICE_UNAVAILABLE,
                "HTTP identity endpoints disabled: configure ksher.data-mcp.internal-auth-token"
            );
        }
        byte[] expectedBytes = expected.getBytes(StandardCharsets.UTF_8);
        byte[] actualBytes = internalAuth == null
            ? new byte[0]
            : internalAuth.getBytes(StandardCharsets.UTF_8);
        if (!MessageDigest.isEqual(expectedBytes, actualBytes)) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "invalid internal auth");
        }
    }

    private Map<String, String> toPythonValidationRequest(AgentSqlRequest request) {
        Map<String, String> payload = toPythonRequestBase(request);
        payload.put("execution_mode", request.executionMode());
        return payload;
    }

    private Map<String, String> toPythonExecutionRequest(AgentSqlRequest request) {
        Map<String, String> payload = toPythonRequestBase(request);
        if (request.queryPlanId() != null && !request.queryPlanId().isBlank()) {
            payload.put("query_plan_id", request.queryPlanId());
        }
        return payload;
    }

    private Map<String, String> toPythonRequestBase(AgentSqlRequest request) {
        Map<String, String> payload = new LinkedHashMap<>();
        payload.put("request_user_union_id", request.requestUserUnionId());
        if (request.requestUserOpenId() != null && !request.requestUserOpenId().isBlank()) {
            payload.put("request_user_open_id", request.requestUserOpenId());
        }
        if (request.requestLarkAppId() != null && !request.requestLarkAppId().isBlank()) {
            payload.put("request_lark_app_id", request.requestLarkAppId());
        }
        if (request.callerSource() != null && !request.callerSource().isBlank()) {
            payload.put("caller_source", request.callerSource());
        }
        if (request.callerSenderType() != null && !request.callerSenderType().isBlank()) {
            payload.put("caller_sender_type", request.callerSenderType());
        }
        if (request.callerSessionId() != null && !request.callerSessionId().isBlank()) {
            payload.put("caller_session_id", request.callerSessionId());
        }
        if (request.callerTaskId() != null && !request.callerTaskId().isBlank()) {
            payload.put("caller_task_id", request.callerTaskId());
        }
        if (request.callerTurnId() != null && !request.callerTurnId().isBlank()) {
            payload.put("caller_turn_id", request.callerTurnId());
        }
        if (request.callerCapturedAt() != null && !request.callerCapturedAt().isBlank()) {
            payload.put("caller_captured_at", request.callerCapturedAt());
        }
        if (request.requestUserTchouseAccount() != null
            && !request.requestUserTchouseAccount().isBlank()) {
            payload.put("request_user_tchouse_account", request.requestUserTchouseAccount());
        }
        payload.put("sql", request.sql());
        payload.put("datasource", request.datasource());
        return payload;
    }

    private Map<String, Object> toPythonExportRequest(AgentExportRequest request) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("request_user_union_id", request.requestUserUnionId());
        if (request.requestUserOpenId() != null && !request.requestUserOpenId().isBlank()) {
            payload.put("request_user_open_id", request.requestUserOpenId());
        }
        if (request.requestLarkAppId() != null && !request.requestLarkAppId().isBlank()) {
            payload.put("request_lark_app_id", request.requestLarkAppId());
        }
        if (request.callerSource() != null && !request.callerSource().isBlank()) {
            payload.put("caller_source", request.callerSource());
        }
        if (request.callerSenderType() != null && !request.callerSenderType().isBlank()) {
            payload.put("caller_sender_type", request.callerSenderType());
        }
        if (request.callerSessionId() != null && !request.callerSessionId().isBlank()) {
            payload.put("caller_session_id", request.callerSessionId());
        }
        if (request.callerTaskId() != null && !request.callerTaskId().isBlank()) {
            payload.put("caller_task_id", request.callerTaskId());
        }
        if (request.callerTurnId() != null && !request.callerTurnId().isBlank()) {
            payload.put("caller_turn_id", request.callerTurnId());
        }
        if (request.callerCapturedAt() != null && !request.callerCapturedAt().isBlank()) {
            payload.put("caller_captured_at", request.callerCapturedAt());
        }
        if (request.requestUserTchouseAccount() != null
            && !request.requestUserTchouseAccount().isBlank()) {
            payload.put("request_user_tchouse_account", request.requestUserTchouseAccount());
        }
        payload.put("sql", request.sql());
        payload.put("datasource", request.datasource());
        if (request.queryPlanId() != null && !request.queryPlanId().isBlank()) {
            payload.put("query_plan_id", request.queryPlanId());
        }
        if (request.filename() != null && !request.filename().isBlank()) {
            payload.put("filename", request.filename());
        }
        if (request.maxExportRows() != null) {
            payload.put("max_export_rows", request.maxExportRows());
        }
        return payload;
    }
}
