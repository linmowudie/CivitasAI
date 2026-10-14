package com.civitas.server.json;

import com.fasterxml.jackson.core.JsonGenerator;
import com.fasterxml.jackson.databind.JsonSerializer;
import com.fasterxml.jackson.databind.SerializerProvider;

import java.io.IOException;
import java.time.Instant;

/** Instant → 'yyyy-MM-ddTHH:mm:ss.SSSZ'（等价 JS toISOString，含微秒数据截断为毫秒） */
public class IsoInstantSerializer extends JsonSerializer<Instant> {
    @Override
    public void serialize(Instant value, JsonGenerator gen, SerializerProvider serializers) throws IOException {
        gen.writeString(IsoTimes.format(value));
    }
}
