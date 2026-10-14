package com.civitas.server.http.validation;

import com.civitas.server.http.Errors;
import com.civitas.server.json.IsoTimes;
import com.civitas.server.util.JsNumber;
import com.fasterxml.jackson.databind.JsonNode;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * 极简校验框架 —— 与 TS 版 Zod 的**对外行为**对位：
 *  - 失败统一抛 VALIDATION_ERROR『请求参数校验失败』，details.issues = [{path, message, code}]；
 *  - path 为 `scope.field`（scope 通常是 'body'；数组元素如 'body.items.0.title'）；
 *  - issue 顺序与 schema 声明一致；
 *  - 文案为自定义信息或 Zod 默认模板（如 `String must contain at most 64 character(s)`、
 *    `Number must be greater than or equal to 1`、`Expected integer, received float`）。
 *
 * 约定：修饰方法（optional / nullable / nullish / defaultTo）必须在类型方法（str / num / bool / enumOf）之前调用。
 */
public final class Validator {
    private Validator() {}

    /** 建立对象校验作用域；body 为 null 表示请求体缺失（对位 undefined） */
    public static Obj object(JsonNode body, String scope) {
        return new Obj(body, scope, new ArrayList<>(), false);
    }

    public static String typeName(JsonNode node) {
        if (node == null || node.isMissingNode()) return "undefined";
        if (node.isNull()) return "null";
        if (node.isTextual()) return "string";
        if (node.isNumber()) return "number";
        if (node.isBoolean()) return "boolean";
        if (node.isArray()) return "array";
        if (node.isObject()) return "object";
        return "unknown";
    }

    /**
     * zod v3.25 datetimeRegex({ offset: true }) 的逐字对位（precision 为空 → 秒可选）。
     * 例：2026-03-01T01:00:00.000Z、2026-03-01T01:00Z、2026-03-01T09:30:00+08:00。
     */
    static final Pattern DATETIME = Pattern.compile(
            "^((\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29"
                    + "|\\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\\d|3[01])|(0[469]|11)-(0[1-9]|[12]\\d|30)"
                    + "|(02)-(0[1-9]|1\\d|2[0-8])))"
                    + "T(([01]\\d|2[0-3]):[0-5]\\d(:[0-5]\\d(\\.\\d+)?)?)"
                    + "(Z|([+-]\\d{2}:?\\d{2}))$");

    public static final class Obj {
        private final JsonNode node;
        private final String scope;
        private final List<Map<String, Object>> issues;
        /** 本作用域已失败（或上层失败）——后续字段不再产生级联报错（对位 Zod 的中止语义） */
        private final boolean dead;

        private Obj(JsonNode body, String scope, List<Map<String, Object>> sharedIssues, boolean inheritedDead) {
            this.scope = scope;
            this.issues = sharedIssues;
            if (inheritedDead) {
                this.node = null;
                this.dead = true;
                return;
            }
            if (body == null) {
                this.node = null;
                this.dead = true;
                addIssue("", "Required", "invalid_type");
            } else if (body.isNull()) {
                this.node = null;
                this.dead = true;
                addIssue("", "Expected object, received null", "invalid_type");
            } else if (!body.isObject()) {
                this.node = null;
                this.dead = true;
                addIssue("", "Expected object, received " + typeName(body), "invalid_type");
            } else {
                this.node = body;
                this.dead = false;
            }
        }

        public Field field(String name) {
            if (dead || node == null) return new Field(this, name, null, true);
            JsonNode value = node.get(name);
            if (value != null && value.isMissingNode()) value = null;
            return new Field(this, name, value, false);
        }

        /** 非对象值（如字符串数组的元素）按“路径字段”校验：issue 路径为 scope + '.' + path */
        public Field fieldAt(String path, JsonNode raw) {
            return new Field(this, path, raw, dead);
        }

        /** 字段是否出现在对象里（含 JSON null —— 与 Zod 的 undefined/null 区分语义对位） */
        public boolean has(String name) {
            return node != null && node.has(name);
        }

        /** 嵌套对象/数组元素作用域：issue 路径带前缀（如 body.items.0），共享同一 issues 列表 */
        public Obj child(JsonNode element, String path) {
            return new Obj(element, scope + "." + path, issues, dead);
        }

        void addIssue(String path, String message, String code) {
            Map<String, Object> issue = new LinkedHashMap<>();
            issue.put("path", path.isEmpty() ? scope : (scope.isEmpty() ? path : scope + "." + path));
            issue.put("message", message);
            issue.put("code", code);
            issues.add(issue);
        }

        /** 对象级 refine：仅当字段均无错误时执行（对位 Zod 的中止语义） */
        public void refine(boolean ok, String message) {
            if (ok || !issues.isEmpty()) return;
            addIssue("", message, "custom");
        }

        /** 校验收尾：有任何问题即抛 VALIDATION_ERROR */
        public void finish() {
            if (issues.isEmpty()) return;
            throw Errors.badRequest("请求参数校验失败", Errors.details("issues", issues));
        }
    }

    public static final class Field {
        private final Obj owner;
        private final String name;
        private final JsonNode raw;
        private boolean optional;
        private boolean nullable;
        private String defaultValue;
        private Double defaultNumber;
        /** 类型错误 → 停止后续检查（对位 Zod 的 aborted） */
        private boolean invalid;
        /** 作用域已失败 → 一切检查静默（不产生级联报错） */
        private final boolean dead;
        /** str() 成功后提取的值（链式变换会更新） */
        private String text;
        /** bool() 成功后提取的值 */
        private Boolean flag;
        /** num()/numCoerced() 成功后提取的值 */
        private Double number;
        /** record() 成功后提取的对象 */
        private JsonNode objectNode;
        /** array() 成功后提取的数组 */
        private JsonNode arrayNode;
        /** isoDateTime() 校验通过后解析出的时间 */
        private Instant instant;

        Field(Obj owner, String name, JsonNode raw, boolean dead) {
            this.owner = owner;
            this.name = name;
            this.raw = raw;
            this.dead = dead;
        }

        /** 原始节点（用于可选字段的存在性判断与字面量校验） */
        public JsonNode raw() {
            return raw;
        }

        public Field optional() {
            this.optional = true;
            return this;
        }

        public Field nullable() {
            this.nullable = true;
            return this;
        }

        public Field nullish() {
            this.optional = true;
            this.nullable = true;
            return this;
        }

        public Field defaultTo(String value) {
            this.defaultValue = value;
            return this;
        }

        public Field defaultTo(double value) {
            this.defaultNumber = value;
            return this;
        }

        // ── 字符串 ────────────────────────────────────────────────────

        public Field str() {
            if (raw == null) {
                if (defaultValue != null) {
                    text = defaultValue;
                } else if (!optional) {
                    typeIssue("Required");
                }
                return this;
            }
            if (raw.isNull()) {
                if (!nullable) typeIssue("Expected string, received null");
                return this;
            }
            if (!raw.isTextual()) {
                typeIssue("Expected string, received " + typeName(raw));
                return this;
            }
            text = raw.textValue();
            return this;
        }

        /** trim 变换（等价 Zod .trim()，在长度检查之前生效） */
        public Field trim() {
            if (text != null) text = text.trim();
            return this;
        }

        /** 小写变换（等价 Zod .toLowerCase()） */
        public Field lower() {
            if (text != null) text = text.toLowerCase(Locale.ROOT);
            return this;
        }

        public Field minLen(int minimum, String message) {
            if (checkable() && text.length() < minimum) {
                addCheckIssue(message != null ? message
                        : "String must contain at least " + minimum + " character(s)", "too_small");
            }
            return this;
        }

        public Field maxLen(int maximum, String message) {
            if (checkable() && text.length() > maximum) {
                addCheckIssue(message != null ? message
                        : "String must contain at most " + maximum + " character(s)", "too_big");
            }
            return this;
        }

        public Field email(String message) {
            if (checkable() && !EmailPattern.EMAIL.matcher(text).matches()) {
                addCheckIssue(message, "invalid_string");
            }
            return this;
        }

        public Field regex(Pattern pattern, String message) {
            if (checkable() && !pattern.matcher(text).find()) {
                addCheckIssue(message, "custom");
            }
            return this;
        }

        /** ISO 8601 时间（含时区）—— 对位 `z.string().datetime({ offset: true })` */
        public Field isoDateTime(String message) {
            if (!checkable()) return this;
            if (!DATETIME.matcher(text).matches()) {
                addCheckIssue(message, "invalid_string");
                return this;
            }
            instant = IsoTimes.parseOffsetDateTime(text);
            return this;
        }

        // ── 数字 ──────────────────────────────────────────────────────

        /** 严格数字（JSON number）—— 对位 `z.number()` */
        public Field num() {
            if (raw == null) {
                if (defaultNumber != null) {
                    number = defaultNumber;
                } else if (!optional) {
                    typeIssue("Required");
                }
                return this;
            }
            if (raw.isNull()) {
                if (!nullable) typeIssue("Expected number, received null");
                return this;
            }
            if (!raw.isNumber()) {
                typeIssue("Expected number, received " + typeName(raw));
                return this;
            }
            number = raw.doubleValue();
            return this;
        }

        /** 强制转型数字（查询串场景）—— 对位 `z.coerce.number()`（Number(input) 语义） */
        public Field numCoerced() {
            if (raw == null) {
                if (defaultNumber != null) {
                    number = defaultNumber;
                } else if (!optional) {
                    // Number(undefined) → NaN → 'nan'（对位 z.coerce.number() 的 undefined 分支）
                    typeIssue("Expected number, received nan");
                }
                return this;
            }
            if (raw.isNumber()) {
                number = raw.doubleValue();
                return this;
            }
            if (raw.isTextual()) {
                double parsed = jsNumber(raw.textValue());
                if (Double.isNaN(parsed)) typeIssue("Expected number, received nan");
                else number = parsed;
                return this;
            }
            if (raw.isBoolean()) {
                number = raw.booleanValue() ? 1.0 : 0.0;
                return this;
            }
            if (raw.isNull()) {
                number = 0.0;
                return this;
            }
            typeIssue("Expected number, received nan");
            return this;
        }

        public Field finite() {
            if (checkableNumber() && !Double.isFinite(number)) {
                addCheckIssue("Number must be finite", "not_finite");
            }
            return this;
        }

        /** 整数检查 —— 对位 `.int()`（非整数 → invalid_type「Expected integer, received float」） */
        public Field integer() {
            if (checkableNumber() && number % 1 != 0) {
                addCheckIssue("Expected integer, received float", "invalid_type");
            }
            return this;
        }

        public Field minNumber(double minimum, String message) {
            if (checkableNumber() && number < minimum) {
                addCheckIssue(message != null ? message
                        : "Number must be greater than or equal to " + formatNumber(minimum), "too_small");
            }
            return this;
        }

        public Field maxNumber(double maximum, String message) {
            if (checkableNumber() && number > maximum) {
                addCheckIssue(message != null ? message
                        : "Number must be less than or equal to " + formatNumber(maximum), "too_big");
            }
            return this;
        }

        /** 正数（不含 0）—— 对位 `.positive()` */
        public Field positive() {
            if (checkableNumber() && number <= 0) {
                addCheckIssue("Number must be greater than 0", "too_small");
            }
            return this;
        }

        // ── 对象 / 数组 ───────────────────────────────────────────────

        /** 自由 JSON 对象 —— 对位 `z.record(z.unknown())` */
        public Field record() {
            if (raw == null) {
                if (!optional) typeIssue("Required");
                return this;
            }
            if (raw.isNull()) {
                if (!nullable) typeIssue("Expected object, received null");
                return this;
            }
            if (!raw.isObject()) {
                typeIssue("Expected object, received " + typeName(raw));
                return this;
            }
            objectNode = raw;
            return this;
        }

        /** 数组（元素不做校验收尾由 length 检查承担）—— 对位 `z.array(...)` */
        public Field array() {
            if (raw == null) {
                if (!optional) typeIssue("Required");
                return this;
            }
            if (raw.isNull()) {
                if (!nullable) typeIssue("Expected array, received null");
                return this;
            }
            if (!raw.isArray()) {
                typeIssue("Expected array, received " + typeName(raw));
                return this;
            }
            arrayNode = raw;
            return this;
        }

        public Field minItems(int minimum, String message) {
            if (arrayNode != null && arrayNode.size() < minimum) {
                addCheckIssue(message != null ? message
                        : "Array must contain at least " + minimum + " element(s)", "too_small");
            }
            return this;
        }

        public Field maxItems(int maximum, String message) {
            if (arrayNode != null && arrayNode.size() > maximum) {
                addCheckIssue(message != null ? message
                        : "Array must contain at most " + maximum + " element(s)", "too_big");
            }
            return this;
        }

        // ── 枚举（字符串字面量）────────────────────────────────────────

        public Field enumOf(String... allowed) {
            String options = "'" + String.join("' | '", allowed) + "'";
            if (raw == null) {
                if (defaultValue != null) {
                    text = defaultValue;
                } else if (!optional) {
                    typeIssue("Required");
                }
                return this;
            }
            if (raw.isNull()) {
                if (!nullable) typeIssue("Expected " + options + ", received null");
                return this;
            }
            if (!raw.isTextual()) {
                typeIssue("Expected " + options + ", received " + typeName(raw));
                return this;
            }
            text = raw.textValue();
            boolean matched = false;
            for (String candidate : allowed) {
                if (candidate.equals(text)) {
                    matched = true;
                    break;
                }
            }
            if (!matched) {
                addCheckIssue("Invalid enum value. Expected " + options + ", received '" + text + "'", "invalid_enum_value");
            }
            return this;
        }

        // ── 取值 ──────────────────────────────────────────────────────

        public String text() {
            return text;
        }

        public Boolean flag() {
            return flag;
        }

        public Double number() {
            return number;
        }

        /** 校验通过的数字取值（整数展开为 Integer，便于直接绑定） */
        public Integer intValue() {
            return number == null ? null : (int) Math.floor(number);
        }

        public JsonNode object() {
            return objectNode;
        }

        public JsonNode arrayNode() {
            return arrayNode;
        }

        public Instant instant() {
            return instant;
        }

        // ── 布尔 ──────────────────────────────────────────────────────

        public Field bool() {
            if (raw == null) {
                if (!optional) typeIssue("Required");
                return this;
            }
            if (raw.isNull()) {
                if (!nullable) typeIssue("Expected boolean, received null");
                return this;
            }
            if (!raw.isBoolean()) {
                typeIssue("Expected boolean, received " + typeName(raw));
                return this;
            }
            flag = raw.booleanValue();
            return this;
        }

        // ── 内部 ──────────────────────────────────────────────────────

        /** 已成功提取字符串且未发生类型错误时，才执行字符检查 */
        private boolean checkable() {
            return !invalid && text != null;
        }

        private boolean checkableNumber() {
            return !invalid && number != null;
        }

        private void typeIssue(String message) {
            if (dead) return;
            invalid = true;
            owner.addIssue(name, message, "invalid_type");
        }

        private void addCheckIssue(String message, String code) {
            if (dead) return;
            owner.addIssue(name, message, code);
        }

        /** JS `Number(string)` 语义（查询参数强制转型用） */
        private static double jsNumber(String value) {
            return JsNumber.parse(value);
        }

        /** JS 模板字符串中的数字格式（`${1}` → "1"，`${0}` → "0"） */
        private static String formatNumber(double value) {
            if (Double.isFinite(value) && value == Math.floor(value) && Math.abs(value) < 1e15) {
                return String.valueOf((long) value);
            }
            return String.valueOf(value);
        }
    }

    /** zod v3.25 内置邮箱正则（逐字对齐，含 i 旗标语义） */
    static final class EmailPattern {
        static final Pattern EMAIL = Pattern.compile(
                "^(?!\\.)(?!.*\\.\\.)([A-Z0-9_'+.\\-]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9\\-]*\\.)+[A-Z]{2,}$",
                Pattern.CASE_INSENSITIVE);
    }
}
