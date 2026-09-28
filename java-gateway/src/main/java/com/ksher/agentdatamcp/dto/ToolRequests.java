package com.ksher.agentdatamcp.dto;

import jakarta.validation.constraints.NotBlank;

public final class ToolRequests {
    private ToolRequests() {
    }

    public record AgentSqlRequest(
        @NotBlank String requestUserUnionId,
        String requestUserOpenId,
        String requestLarkAppId,
        String callerSource,
        String callerSenderType,
        String callerSessionId,
        String callerTaskId,
        String callerTurnId,
        String callerCapturedAt,
        String requestUserTchouseAccount,
        @NotBlank String sql,
        String datasource,
        String queryPlanId,
        String executionMode
    ) {
        public AgentSqlRequest {
            if (datasource == null || datasource.isBlank()) {
                datasource = "tchouse-c";
            }
            if (executionMode == null || executionMode.isBlank()) {
                executionMode = "single";
            }
        }
    }

    public record AgentExportRequest(
        @NotBlank String requestUserUnionId,
        String requestUserOpenId,
        String requestLarkAppId,
        String callerSource,
        String callerSenderType,
        String callerSessionId,
        String callerTaskId,
        String callerTurnId,
        String callerCapturedAt,
        String requestUserTchouseAccount,
        @NotBlank String sql,
        String datasource,
        String queryPlanId,
        String filename,
        Integer maxExportRows
    ) {
        public AgentExportRequest {
            if (datasource == null || datasource.isBlank()) {
                datasource = "tchouse-c";
            }
        }
    }
}
