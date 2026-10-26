package com.boxxieshare.app;

import android.content.pm.ServiceInfo;
import org.junit.Test;
import static org.junit.Assert.*;
import java.io.File;
import java.util.Arrays;
import javax.xml.parsers.DocumentBuilderFactory;
import org.w3c.dom.Element;
import org.w3c.dom.NodeList;

public class ScreenShareServiceTest {
    @Test public void android11AndLaterDeclareForegroundRecordingCapability() {
        for (int sdk : new int[]{30, 31, 34, 36}) {
            int types = ScreenShareService.foregroundTypes(sdk, true);
            assertTrue((types & ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION) != 0);
            assertTrue("AudioRecord needs a recording foreground service on SDK " + sdk,
                    (types & ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE) != 0);
        }
    }

    @Test public void olderDevicesAndDeniedAudioPermissionKeepVideoOnlyTypes() {
        assertEquals(0, ScreenShareService.foregroundTypes(28, true));
        assertEquals(ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION,
                ScreenShareService.foregroundTypes(29, true));
        assertEquals(ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION,
                ScreenShareService.foregroundTypes(34, false));
    }

    @Test public void manifestDeclaresTypesAndPermissionsUsedAtRuntime() throws Exception {
        String ns = "http://schemas.android.com/apk/res/android";
        DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
        factory.setNamespaceAware(true);
        Element root = factory.newDocumentBuilder().parse(new File(System.getProperty("boxxie.manifest"))).getDocumentElement();
        boolean record = false, foregroundRecord = false, projection = false, serviceFound = false;
        NodeList permissions = root.getElementsByTagName("uses-permission");
        for (int i = 0; i < permissions.getLength(); i++) {
            String name = ((Element) permissions.item(i)).getAttributeNS(ns, "name");
            record |= name.equals("android.permission.RECORD_AUDIO");
            foregroundRecord |= name.equals("android.permission.FOREGROUND_SERVICE_MICROPHONE");
            projection |= name.equals("android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION");
        }
        NodeList services = root.getElementsByTagName("service");
        for (int i = 0; i < services.getLength(); i++) {
            Element service = (Element) services.item(i);
            if (!service.getAttributeNS(ns, "name").equals(".ScreenShareService")) continue;
            serviceFound = true;
            java.util.List<String> types = Arrays.asList(service.getAttributeNS(ns, "foregroundServiceType").split("\\|"));
            assertTrue(types.contains("mediaProjection"));
            assertTrue(types.contains("microphone"));
        }
        assertTrue(serviceFound && record && foregroundRecord && projection);
    }
}
