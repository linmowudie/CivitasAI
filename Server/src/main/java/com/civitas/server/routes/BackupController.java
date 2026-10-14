package com.civitas.server.routes;

import com.civitas.server.http.ApiResponse;
import com.civitas.server.http.AuthContext;
import com.civitas.server.http.RequireAuth;
import com.civitas.server.http.validation.BackupBodies;
import com.civitas.server.json.IsoTimes;
import com.civitas.server.json.Json;
import com.civitas.server.services.BackupService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.time.Instant;

/**
 * 一键备份 / 恢复 —— 与 TS 版 `src/routes/backup.ts` 对位：
 *
 *   GET  /v1/backup            导出完整数据包（设置 + 记忆 + 可选统计）
 *   GET  /v1/backup/download   以附件形式下载（便于用户自行保存到本地）
 *   POST /v1/restore           从数据包恢复（mode=merge 合并 / replace 重建）
 */
@RestController
public final class BackupController {
    private final BackupService backup;

    public BackupController(BackupService backup) {
        this.backup = backup;
    }

    @GetMapping("/v1/backup")
    @RequireAuth
    public ResponseEntity<ApiResponse.OkBody<BackupService.BackupBundle>> export(
            AuthContext authCtx,
            @RequestParam(value = "includeStats", required = false) String includeStats,
            @RequestParam(value = "statsLimit", required = false) String statsLimit) {
        BackupBodies.ExportQuery query = BackupBodies.exportQuery(exportQueryNode(includeStats, statsLimit));
        // SV-001 闭环：透传 statsLimit——缺省即键集分页全量导出（无静默上限），
        // 显式传入时按 limit 截断并在包内 `truncated.stats` 如实标注。
        return ApiResponse.okResponse(
                backup.export(authCtx.userId(), query.includeStats(), query.statsLimit()));
    }

    /** 下载为 JSON 附件（含文件名），方便“卸载前导出、重装后导入” */
    @GetMapping("/v1/backup/download")
    @RequireAuth
    public ResponseEntity<BackupService.BackupBundle> download(
            AuthContext authCtx,
            @RequestParam(value = "includeStats", required = false) String includeStats,
            @RequestParam(value = "statsLimit", required = false) String statsLimit) {
        BackupBodies.ExportQuery query = BackupBodies.exportQuery(exportQueryNode(includeStats, statsLimit));
        BackupService.BackupBundle bundle =
                backup.export(authCtx.userId(), query.includeStats(), query.statsLimit());
        // 对位 JS `new Date().toISOString().replace(/[:.]/g, '-')`
        String stamp = IsoTimes.format(Instant.now()).replaceAll("[:.]", "-");
        return ResponseEntity.ok()
                .contentType(MediaType.parseMediaType("application/json; charset=utf-8"))
                .header("Content-Disposition", "attachment; filename=\"civitas-backup-" + stamp + ".json\"")
                .body(bundle);
    }

    @PostMapping("/v1/restore")
    @RequireAuth
    public ResponseEntity<ApiResponse.OkBody<BackupService.RestoreReport>> restore(
            AuthContext authCtx, @RequestBody(required = false) JsonNode body) {
        BackupBodies.RestoreBody parsed = BackupBodies.restore(body);
        return ApiResponse.okResponse(backup.restore(authCtx.userId(), parsed.bundle(), parsed.mode()));
    }

    /** 组装查询串校验输入（只放入实际出现的参数） */
    private static ObjectNode exportQueryNode(String includeStats, String statsLimit) {
        ObjectNode node = Json.MAPPER.createObjectNode();
        if (includeStats != null) node.put("includeStats", includeStats);
        if (statsLimit != null) node.put("statsLimit", statsLimit);
        return node;
    }
}
