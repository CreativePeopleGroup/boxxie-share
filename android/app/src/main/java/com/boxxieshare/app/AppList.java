package com.boxxieshare.app;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.drawable.Drawable;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** The TV's own apps, so you can open one from inside Boxxie Share while sharing the screen. */
final class AppList {
    private AppList() {}

    static String json(Context ctx) {
        PackageManager pm = ctx.getPackageManager();
        Map<String, ResolveInfo> found = new LinkedHashMap<>();
        // TV apps first (Leanback), then ordinary apps
        for (String cat : new String[] {"android.intent.category.LEANBACK_LAUNCHER", Intent.CATEGORY_LAUNCHER}) {
            Intent i = new Intent(Intent.ACTION_MAIN).addCategory(cat);
            List<ResolveInfo> list;
            try { list = pm.queryIntentActivities(i, 0); } catch (Exception e) { list = Collections.emptyList(); }
            for (ResolveInfo r : list) {
                String pkg = r.activityInfo.packageName;
                if (pkg.equals(ctx.getPackageName()) || found.containsKey(pkg)) continue;
                found.put(pkg, r);
            }
        }
        List<JSONObject> apps = new ArrayList<>();
        for (Map.Entry<String, ResolveInfo> e : found.entrySet()) {
            try {
                JSONObject o = new JSONObject();
                o.put("pkg", e.getKey());
                o.put("label", String.valueOf(e.getValue().loadLabel(pm)));
                o.put("icon", iconData(e.getValue().loadIcon(pm)));
                apps.add(o);
            } catch (Exception ignored) {}
        }
        Collections.sort(apps, (a, b) -> a.optString("label").compareToIgnoreCase(b.optString("label")));
        JSONArray arr = new JSONArray();
        for (JSONObject o : apps) arr.put(o);
        return arr.toString();
    }

    private static String iconData(Drawable d) {
        if (d == null) return "";
        int size = 96;
        Bitmap b = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(b);
        d.setBounds(0, 0, size, size);
        d.draw(c);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        b.compress(Bitmap.CompressFormat.PNG, 100, out);
        b.recycle();
        return "data:image/png;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
    }

    static boolean launch(Context ctx, String pkg) {
        PackageManager pm = ctx.getPackageManager();
        Intent i = pm.getLeanbackLaunchIntentForPackage(pkg);
        if (i == null) i = pm.getLaunchIntentForPackage(pkg);
        if (i == null) return false;
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            ctx.startActivity(i);
            return true;
        } catch (Exception e) {
            return false;
        }
    }
}
