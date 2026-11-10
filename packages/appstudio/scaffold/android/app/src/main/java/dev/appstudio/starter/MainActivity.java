package dev.appstudio.starter;

import android.app.Activity;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Bundle;
import android.text.Editable;
import android.text.TextWatcher;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Starter UI. Add views and interactions here and preserve the debug scene contract. */
public final class MainActivity extends Activity {
    private static final String TITLE = __TITLE_JAVA__;
    private static final String DESIGN = __DESIGN_JAVA__;
    private static final int ACCENT = 0xff4f46e5;
    private JSONArray screens;
    private JSONObject drafts;
    private JSONObject selections;
    private JSONObject offsets;
    private int index;

    @Override protected void onCreate(Bundle savedState) {
        super.onCreate(savedState);
        try {
            screens = new JSONArray(DESIGN);
            JSONObject checkpoint = new JSONObject(SceneStore.load(this));
            drafts = objectAt(checkpoint, "drafts");
            selections = objectAt(checkpoint, "selections");
            offsets = objectAt(checkpoint, "offsets");
            for (int i = 0; i < screens.length(); i++) {
                if (screen(i).optString("id").equals(checkpoint.optString("screen"))) index = i;
            }
            render();
        } catch (Exception error) {
            throw new IllegalStateException("Could not restore the app scene", error);
        }
    }

    private static JSONObject objectAt(JSONObject state, String key) {
        JSONObject value = state.optJSONObject(key);
        return value == null ? new JSONObject() : value;
    }

    private JSONObject screen(int position) { return screens.optJSONObject(position); }
    private String screenId() { return screen(index).optString("id"); }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }

    private void render() {
        JSONObject current = screen(index);
        String currentId = screenId();
        LinearLayout root = column();
        root.setBackgroundColor(0xfff8f9ff);
        root.setPadding(dp(20), dp(20), dp(20), dp(12));
        root.setFocusableInTouchMode(true);
        setContentView(root);
        root.addView(text(TITLE, 26, true));

        if (screens.length() > 1) {
            HorizontalScrollView navigation = new HorizontalScrollView(this);
            navigation.setHorizontalScrollBarEnabled(false);
            LinearLayout tabs = new LinearLayout(this);
            for (int i = 0; i < screens.length(); i++) {
                final int target = i;
                Button tab = button(screen(i).optString("title"));
                tab.setEnabled(i != index);
                tab.setOnClickListener(view -> { index = target; render(); });
                tabs.addView(tab);
            }
            navigation.addView(tabs);
            root.addView(navigation);
        }

        ScrollView scroll = new ScrollView(this);
        scroll.setContentDescription("App content");
        scroll.setFillViewport(true);
        LinearLayout content = column();
        content.setPadding(0, dp(12), 0, dp(20));
        content.addView(text(current.optString("title"), 21, true));
        JSONArray blocks = current.optJSONArray("blocks");
        for (int i = 0; i < blocks.length(); i++) {
            View block = renderBlock(blocks.optJSONObject(i), currentId);
            LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            params.topMargin = dp(12);
            content.addView(block, params);
        }
        scroll.addView(content);
        root.addView(scroll, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        root.requestFocus();
        scroll.post(() -> {
            if (!currentId.equals(screenId())) return;
            scroll.scrollTo(0, offsets.optInt(currentId, 0));
            put(offsets, currentId, scroll.getScrollY());
            scroll.setOnScrollChangeListener((view, x, y, oldX, oldY) -> {
                put(offsets, currentId, y);
                persist();
            });
            persist();
        });
    }

    private View renderBlock(JSONObject block, String currentId) {
        String label = block.optString("text");
        String key = currentId + ":" + block.optString("id");
        return switch (block.optString("kind")) {
            case "heading" -> text(label, 24, true);
            case "text" -> text(label, 16, false);
            case "divider" -> {
                View divider = new View(this);
                divider.setBackgroundColor(0xffdfe3f2);
                divider.setMinimumHeight(dp(1));
                yield divider;
            }
            case "image" -> {
                TextView artwork = text(label, 18, true);
                artwork.setGravity(Gravity.CENTER);
                artwork.setMinimumHeight(dp(126));
                artwork.setBackgroundColor(0xffe5e7ff);
                artwork.setTextColor(ACCENT);
                yield artwork;
            }
            case "input" -> {
                EditText field = new EditText(this);
                field.setSingleLine(true);
                field.setHint(label);
                field.setText(drafts.optString(key));
                field.addTextChangedListener(new TextWatcher() {
                    public void beforeTextChanged(CharSequence value, int start, int count, int after) {}
                    public void onTextChanged(CharSequence value, int start, int before, int count) {
                        put(drafts, key, value.toString());
                        persist();
                    }
                    public void afterTextChanged(Editable value) {}
                });
                yield field;
            }
            case "button" -> {
                Button control = button(label);
                control.setOnClickListener(view -> {
                    if (index + 1 < screens.length()) {
                        index += 1;
                        render();
                    } else {
                        Toast.makeText(this, label, Toast.LENGTH_SHORT).show();
                    }
                });
                yield control;
            }
            case "list" -> {
                LinearLayout list = column();
                String[] items = label.split("\\r?\\n");
                for (int i = 0; i < items.length; i++) {
                    final int itemIndex = i;
                    Button row = button(items[i]);
                    row.setGravity(Gravity.START | Gravity.CENTER_VERTICAL);
                    row.setSelected(selections.optInt(key, -1) == i);
                    if (row.isSelected()) row.setTextColor(ACCENT);
                    row.setOnClickListener(view -> {
                        put(selections, key, itemIndex);
                        for (int j = 0; j < list.getChildCount(); j++) {
                            Button item = (Button) list.getChildAt(j);
                            item.setSelected(j == itemIndex);
                            item.setTextColor(j == itemIndex ? ACCENT : Color.BLACK);
                        }
                        persist();
                    });
                    list.addView(row);
                }
                yield list;
            }
            default -> throw new IllegalArgumentException("Unsupported layout block");
        };
    }

    private LinearLayout column() {
        LinearLayout view = new LinearLayout(this);
        view.setOrientation(LinearLayout.VERTICAL);
        return view;
    }

    private TextView text(String label, int size, boolean bold) {
        TextView view = new TextView(this);
        view.setText(label);
        view.setTextSize(size);
        view.setTextColor(0xff1e243b);
        if (bold) view.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        return view;
    }

    private Button button(String label) {
        Button view = new Button(this);
        view.setText(label);
        view.setAllCaps(false);
        return view;
    }

    private static void put(JSONObject object, String key, Object value) {
        try { object.put(key, value); }
        catch (JSONException error) { throw new IllegalArgumentException("Invalid app state", error); }
    }

    private void persist() {
        JSONObject state = new JSONObject();
        put(state, "screen", screenId());
        put(state, "drafts", drafts);
        put(state, "selections", selections);
        put(state, "offsets", offsets);
        try { SceneStore.save(this, state.toString()); }
        catch (Exception error) { Log.e("AppStudioScene", "Could not publish the test scene", error); }
    }
}
