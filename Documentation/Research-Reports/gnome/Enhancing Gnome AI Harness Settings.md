# **Advanced GNOME AI Harness Architecture: Perfecting Ollama API Integration and Interface Design**

The integration of local Large Language Models (LLMs) into the GNOME desktop environment represents a significant architectural challenge, necessitating a highly robust translation layer between desktop interface conventions and backend AI inference engines. Ollama, a prevalent and highly optimized daemon for local LLM execution, exposes a comprehensive HTTP REST API that allows for real-time, dynamic parameter tuning during inference.1 While foundational configurations can be statically baked into a Modelfile at the time of model building or pulling 3, dynamic desktop harnesses must leverage the API's runtime capabilities to adjust mathematical and hardware parameters on the fly without requiring the user to recompile or reload models from disk.1  
An analysis of the current state of the GNOME AI harness, as evidenced by the provided screenshot, reveals a highly functional but ultimately foundational implementation. The current user interface exposes a Base URL input (http://172.16.0.3:11434), a Model selection field (qwen3.6:35b), a Context Window Size (16000), a Keep Alive duration (5m), and a foundational Probabilistic Sampling control via Temperature (0.70). While this establishes a working connection capable of maintaining a conversational state, it only scratches the surface of the mathematical manipulation, hardware allocation, and degeneration mitigation strategies available within the Ollama ecosystem.  
To update and perfect these settings, the extension must dramatically expand its interaction with the Ollama API payload. This report provides an exhaustive, multi-layered analysis of the advanced configuration parameters exposed by the Ollama API, bridging the gap between computational linguistics and modern Linux desktop UI design. It expands significantly on basic parameter sets by detailing advanced probabilistic sampling, dynamic entropy control, systemic memory management, and token penalization. Furthermore, it establishes strict architectural guidelines for representing these complex floating-point and integer structures within GNOME's GSettings backend and Libadwaita (Adw) frontend widgets, ensuring a seamless, native user experience.

## **The Ollama API Override Architecture**

To properly harness an AI model through an external interface, one must understand the hierarchy of parameter application within the Ollama execution pipeline. Ollama's architecture separates core model weights (often stored in the GGUF format) from inference execution parameters. During an API request to either the /api/generate or /api/chat endpoints, the inference engine accepts a structured JSON payload.2  
Within this payload, there is a nested JSON object labeled options.1 This options object acts as the ultimate override mechanism. Any parameter passed into this dictionary takes strict precedence over the default values defined in the model's underlying Modelfile, as well as any defaults hardcoded into the llama.cpp backend that Ollama utilizes.1 For a GNOME extension serving as an AI harness, the primary operational loop involves reading user preferences from the local GSettings database, serializing these diverse preferences into the options JSON structure, and transmitting them via an asynchronous network request to the Ollama daemon.1  
It is also critical to understand that not all settings belong inside the options dictionary. Some configuration parameters, specifically those governing the structural behavior of the request rather than the mathematical sampling of the model, sit at the top level of the JSON payload. For instance, the keep\_alive parameter, which controls how long the model remains loaded into system memory following a request, is a top-level parameter.7 The existing harness correctly implements this, utilizing a string format like 5m to keep the model in memory for five minutes, preventing the severe latency overhead of reloading a massive 35-billion parameter model from a solid-state drive for subsequent queries.7 Similarly, format (which can force the model to output strict JSON), raw (which strips all chat templating), and stream (which dictates whether the HTTP response is chunked or sent as a single block) are top-level API arguments that the GNOME extension must manage independently of the statistical options.7

## **Expanding the Baseline Interface: Execution and System State**

The current interface's inclusion of a Base URL and Model string serves as the routing foundation for the extension. However, harnessing a model on a local Linux desktop environment requires granular control over how the inference engine interacts with the host operating system's hardware—specifically CPU threads, System RAM, and GPU VRAM. Proper configuration in this domain is absolutely critical; failure to expose these settings can result in the GNOME shell freezing due to out-of-memory (OOM) errors, or the system becoming unresponsive due to aggressive swap file thrashing.

### **Memory Mapping and Page Locking**

Memory management represents a highly critical configuration vector for desktop users who are balancing multiple heavy applications (such as web browsers, IDEs, or virtualization software) alongside local AI execution. The Ollama API exposes two vital booleans for this purpose: use\_mmap and use\_mlock.  
The use\_mmap parameter dictates whether the model weights are mapped directly into the virtual memory space using the operating system's mmap system call.1 When this is enabled, the Linux kernel manages the loading and unloading of the model's memory pages from the storage drive into RAM automatically. This is generally beneficial because if the system's VRAM or standard RAM is saturated, the kernel can efficiently swap idle parts of the model to disk. However, if a user frequently alternates between two large models, relying on mmap can lead to continuous, latency-inducing SSD reads.9  
The use\_mlock parameter provides a more aggressive systemic override. When enabled, this parameter forces the memory pages containing the model to be locked directly into physical RAM, strictly forbidding the Linux kernel from swapping them out to disk.1 This is vital for maintaining low-latency, instantaneous responses for background AI tasks, as retrieving a swapped LLM from a drive introduces severe, multi-second latency spikes. However, locking memory comes with immense systemic risk. If a user enables use\_mlock on a desktop with insufficient RAM to hold the model and the operating system simultaneously, it can cause immediate kernel panics, forced application terminations via the Out-Of-Memory Killer (OOM-Killer), or complete GNOME session crashes.9  
To implement this safely in the GNOME UI, these parameters must be represented by Adw.SwitchRow widgets.6 Because use\_mlock carries such a high risk of system instability if misused by a novice user, architectural best practices dictate placing it inside an Adw.ExpanderRow labeled "Advanced Hardware Settings".10 This introduces a deliberate friction point, preventing accidental activation. Both settings map natively to the b (boolean) data type within the extension's gschema.xml.6

### **Hardware Offloading and Compute Allocation**

Local LLM inference is highly parallelizable, meaning performance scales directly with the hardware allocated to the task. The API provides num\_gpu and num\_thread to manage this allocation.  
The num\_gpu parameter defines the precise number of transformer layers that the backend will attempt to offload to the graphics processing unit (GPU).11 Setting this value to \-1 is a special flag that instructs the engine to offload all possible layers, maximizing generation speed, while a value of 0 forces pure CPU execution.9 Modifying this parameter is essential for a desktop harness because users frequently need to reserve VRAM for graphic-intensive desktop applications, such as 3D rendering engines, video editors, or gaming, while simultaneously keeping the AI active in the background. If the AI consumes all available VRAM, the GNOME compositor itself may experience severe frame drops.  
The num\_thread parameter dictates the number of CPU threads allocated specifically for the mathematical computation of the neural network.12 By default, the backend attempts to align this with the physical core count of the host processor.13 A common misconception is that allocating more threads always yields faster inference. In reality, setting this value higher than the physical core count forces the CPU to constantly context-switch between threads, resulting in severe performance degradation and increased thermal output.  
In the Libadwaita frontend, num\_gpu is best represented by an Adw.SpinRow.15 The underlying GtkAdjustment should feature a minimum lower bound of \-1 and a reasonably high upper bound (e.g., 200, to accommodate massive models with hundreds of layers), utilizing a step\_increment of 1\. The num\_thread parameter requires identical UI treatment. Both parameters strictly require the i (integer) data type in the GSettings schema.16

### **Context Management and State Truncation**

The screenshot provided indicates that the harness already supports a Context Window Size setting, currently tuned to 16000\. In the Ollama API, this maps directly to the num\_ctx parameter.4 This defines the absolute maximum token capacity of the context window.17 A larger context window allows the user to paste extensive documents or massive codebases into the chat, but memory consumption scales quadratically with the context length due to the nature of the transformer attention mechanism.  
To perfect the context management suite, the harness must expand beyond num\_ctx and integrate num\_predict and num\_keep. The num\_predict parameter serves as a hard safety limit, controlling the maximum number of new tokens the model is permitted to generate in a single response.4 A value of \-1 permits infinite generation, allowing the model to stream tokens until it naturally produces an End-Of-Sequence (EOS) token.17 This is useful for long-form content generation, but for quick desktop queries, setting a hard limit (e.g., 500\) ensures the model does not run away and consume compute resources endlessly.  
The num\_keep parameter is an advanced systemic control that dictates exactly how many initial tokens are retained in memory when the context window fills up entirely and needs to be truncated or refreshed.1 Typically, this is used to lock the system prompt into the context so that the AI does not "forget" its core persona or instructions when a conversation goes on for too long.  
From a UI perspective, because num\_ctx fundamentally requires specific architectural values—often powers of two such as 2048, 4096, 8192, or 16384—utilizing an Adw.SpinRow creates a poor user experience, forcing the user to click excessively or type exact numbers.4 Instead, an Adw.ComboRow populated with a dropdown list of standard, optimized context sizes offers a vastly superior, error-free user experience, backed by an integer setting in the schema. Conversely, num\_predict and num\_keep should employ an Adw.SpinRow, allowing the user precise numerical control over token limits.

## **Perfecting Probabilistic Sampling Mechanics**

The core of an LLM's behavioral tuning lies within its sampling algorithms. When a language model processes a prompt and predicts the next word, it does not output a single deterministic answer. Instead, it outputs a highly complex logit distribution across its entire vocabulary, assigning a raw mathematical weight to every conceivable next token. Sampling parameters dictate the algorithms used to select a specific token from this massive distribution. A truly perfected GNOME harness must provide granular, accurate, and scientifically sound controls for these floating-point values.

### **Temperature Scaling**

The screenshot shows that Temperature is currently implemented, set to 0.70. Temperature is the foundational scalar applied to the raw logits before they are converted into normalized probabilities via a softmax function.20 The mathematical application is fundamental to understanding its UI behavior: the raw logit for a token is divided by the temperature before the softmax is calculated.  
When the temperature is set to exactly 1.0, the raw probability distribution produced by the neural network is maintained without alteration. When the temperature is decreased below 1.0, the division increases the relative distance between the logits. The distribution becomes significantly sharper, exaggerating the gap between highly likely and unlikely tokens. A temperature approaching 0.0 results in highly deterministic, focused outputs, essentially turning the model into a greedy search algorithm that always picks the absolute highest probability word. This is the optimal setting for strict logic tasks, mathematics, and code generation.22  
Conversely, when the temperature is increased above 1.0, the division decreases the distance between the logits. The probability distribution flattens out, artificially inflating the probability of selecting obscure, low-ranked tokens. This yields more creative, unpredictable, or chaotic text, which is ideal for brainstorming, poetry, or creative writing.20  
In the Libadwaita frontend, Temperature must be represented by an Adw.SpinRow.15 The underlying GtkAdjustment must have a lower limit of 0.0, an upper limit of 2.0 (as anything above 2.0 generally degenerates into complete gibberish), and a precise step\_increment of 0.05 or 0.1. In the XML schema, this is defined as a d (double precision float) type to ensure data fidelity when passing to the API.16

### **Absolute and Nucleus Truncation (top\_k and top\_p)**

While temperature alters the shape of the distribution, truncation algorithms cut off the distribution entirely, preventing the model from ever selecting tokens that fall below a certain threshold. The API exposes top\_k and top\_p for this exact purpose.  
The top\_k parameter is an absolute, integer-based truncation method. The algorithm sorts the entire vocabulary by probability from highest to lowest, and instantly discards all but the top ![][image1] most likely tokens.4 If top\_k is set to 40, only the 40 most probable words are considered; everything else is assigned a probability of zero.4 This acts as a brute-force safety net, drastically reducing the probability of the model hallucinating or generating utter nonsense.  
The top\_p parameter, widely known in computational linguistics as Nucleus Sampling, is a dynamic truncation method based on floating-point probabilities. The algorithm sums the probabilities of the sorted tokens from highest to lowest. Once the cumulative sum of these probabilities exceeds the threshold ![][image2], all remaining tokens in the tail are permanently discarded.20 For example, a top\_p of 0.9 retains only the core set of tokens that together represent 90% of the total probability mass.23  
The primary mathematical limitation of top\_p is that it does not adapt well to the model's internal confidence. In scenarios where the model is highly uncertain (a "flat" distribution where dozens of words have similar, low probabilities), reaching the 90% cumulative threshold might inadvertently require including hundreds of highly unlikely tokens in the candidate pool, severely degrading output quality and leading to erratic sentence structures.23

### **Adaptive Thresholding via Minimum Probability (min\_p)**

To address the inherent structural flaws of Nucleus Sampling, modern inference engines introduced the min\_p parameter. This parameter acts as a structurally superior alternative to top\_p, explicitly aiming to ensure a perfect balance of textual quality and conversational variety.4  
Instead of looking at cumulative probability, min\_p filters the vocabulary by establishing a dynamic, moving floor based directly on the probability of the single most likely token.23 The threshold is calculated by multiplying the min\_p value by the probability of the top token.4 For example, if min\_p is set to 0.05, and the single most likely next word has a probability of 80% (0.80), the threshold becomes 4% (0.04). Any token with a probability below 4% is instantly filtered out of the selection pool.4  
The critical architectural advantage of min\_p is its extreme, inherent adaptability based on the model's current state of confidence:

* **High Confidence States:** If the model is highly certain about the next word (e.g., the top token has a 90% probability), the multiplication yields a high threshold. This results in a tiny, highly focused candidate set, preventing the model from randomly choosing a bad word just for the sake of diversity.23  
* **Low Confidence States:** If the model is highly uncertain and probabilities are spread out evenly among many valid options (e.g., the top token only has a 15% probability), the calculated threshold drops dramatically. This allows a much wider array of candidates to pass through the filter, permitting necessary creativity exactly when the context naturally demands it.23

For the UI implementation strategy, top\_k strictly requires an integer-based Adw.SpinRow (typically ranging from 0 to 150). Both top\_p and min\_p require highly precise floating-point Adw.SpinRow widgets ranging from 0.0 to 1.0, utilizing a fine step\_increment of 0.01 or 0.05 to allow for meticulous tuning.15

## **Advanced Statistical Tail and Dynamic Entropy Control**

Beyond the standard trinity of Temperature, Top-K, and Top/Min-P, the Ollama API exposes deeper, highly advanced statistical controls that cater to power users and AI researchers. Exposing these in the GNOME harness requires careful UI nesting to avoid overwhelming the average desktop user.

### **Advanced Distribution Snipping (tfs\_z and typical\_p)**

The tfs\_z parameter, which stands for Tail Free Sampling, seeks to identify and eliminate the irrelevant "tail" of the probability distribution by taking the second derivative of the token probabilities.1 Instead of relying on a hard percentage or a relative floor, it mathematically analyzes the curve of the distribution and removes tokens at the exact point where the probability curve flattens out. A value of 1.0 disables the algorithm entirely, while values like 0.9 or 0.95 enable a tight, mathematically precise tail removal.1  
The typical\_p parameter utilizes a completely different branch of mathematics: information theory. It measures the raw information content, or entropy, of the available tokens. It then actively penalizes tokens that are either *too predictable* or *too surprising*.1 The goal of typical\_p is to force the model to match the localized entropy of the generated text to the expected, average entropy of natural human language, resulting in text that flows naturally without becoming overly robotic or overly eccentric.  
Because tfs\_z and typical\_p are highly complex and rarely adjusted by standard users in daily chat scenarios, UI design principles dictate that they should be grouped together inside an Adw.ExpanderRow titled "Advanced Statistical Sampling".10 This encapsulates the complexity, reducing cognitive load in the main preferences view while still providing power users with the tools they need. Both parameters map to double precision types (d) in GSettings.

### **Dynamic Entropy Targeting with Mirostat**

Traditional sampling algorithms suffer from a fundamental UX flaw: they require the user to manually balance a half-dozen floating-point parameters. Furthermore, as a prompt naturally evolves, a static temperature setting might be too conservative for an introductory paragraph, but too chaotic for a concluding summary. To solve this, the Ollama API supports **Mirostat**, a cutting-edge algorithm that dynamically and continuously self-adjusts the truncation thresholds during generation to maintain a constant, user-defined level of perplexity (entropy).24  
Integrating Mirostat into the GNOME harness requires managing three interconnected API parameters:

* **mirostat:** An integer that acts as the master systemic toggle. Setting it to 0 disables the algorithm entirely, 1 enables standard Mirostat, and 2 enables Mirostat 2.0, a highly optimized and faster version of the algorithm.13  
* **mirostat\_tau (Target Entropy):** A floating-point value that dictates the user's desired balance between strict coherence and wild diversity.24 A lower value (such as 3.0) forces the model to hit a low entropy target, producing highly predictable, focused, and coherent text. A higher value (such as 5.0 or 8.0) pushes the model to aim for high entropy, generating more surprising and diverse text.13  
* **mirostat\_eta (Learning Rate):** A float that determines exactly how aggressively the Mirostat algorithm adjusts its internal parameters in response to the feedback from the generated text.24 A value of 0.1 provides a low learning rate, resulting in smooth, slow, and stable adjustments. Higher values make the algorithm highly reactive, sharply correcting the perplexity if it drifts off target.24

**Architectural Insight for UI State Binding:** Mirostat presents a profound UI/UX challenge for extension developers. When the mirostat parameter is active (set to 1 or 2), the Ollama backend effectively ignores static sampling parameters like temperature, top\_p, and top\_k, overriding them entirely with its own dynamic calculations.25 An expertly designed GNOME AI harness must physically reflect this hardware reality in the interface to prevent severe user confusion.  
In the extension's prefs.js frontend logic, active event listeners must be attached to the mirostat GSettings key. When the backend detects that mirostat is set to 1 or 2, the sensitive property (which dictates whether a GTK widget is active and clickable) of the Adw.SpinRow widgets for temperature, top\_p, min\_p, and top\_k must be dynamically set to false. This greys out the static controls, visually communicating to the user that they are currently inert. Simultaneously, the Adw.SpinRow widgets for mirostat\_tau and mirostat\_eta should become active and sensitive. This reactive UI binding ensures the user is never frustrated by adjusting settings that are currently being silently ignored by the API.

## **Degeneration Mitigation: Token Penalization Strategies**

Autoregressive language models exhibit a well-documented and highly problematic flaw known as degeneration, where the model falls into infinite repetitive loops, reciting the exact same phrases or syntactic structures indefinitely.26 The Ollama API offers three distinct mathematical approaches to penalize tokens based on their prior appearance in the active context. Understanding the fundamental mathematical difference between multiplicative and subtractive penalties is essential for correctly categorizing them in the desktop UI.

### **The Lookback Window (repeat\_last\_n)**

Before any penalization algorithm can be applied, the system must know exactly how far back in the context window to look. The repeat\_last\_n parameter is an integer that dictates the exact size of this sliding observation window.4 If it is set to 64, the penalization algorithms only check the immediate 64 previously generated tokens for repetitions.4 This is computationally cheap but allows long-range repetitions. Setting the parameter to \-1 is a systemic override that forces the model to scan the entire active context window (num\_ctx) for repetitions, ensuring absolute maximum anti-repetition accuracy, albeit at a slightly increased computational cost.4

### **Multiplicative Mitigation (repeat\_penalty)**

The standard repeat\_penalty is a highly aggressive multiplicative scalar applied directly to the raw logits of any tokens that have previously appeared in the defined lookback window.26 Because it acts as a divisor against the logit, a baseline value of 1.0 implies no penalty whatsoever. A value of 1.1 or 1.2 severely diminishes the mathematical likelihood of the token being chosen again.1  
The critical aspect of a multiplicative penalty is that it scales aggressively with the magnitude of the logit itself. A highly probable word is punished mathematically much more severely than a low-probability word.26 This makes repeat\_penalty an exceptionally blunt instrument—highly effective at shattering infinite loops, but prone to disrupting natural grammatical structures if set too high.

### **Subtractive Mitigation (presence\_penalty and frequency\_penalty)**

In direct contrast to the multiplicative scaling of the repeat penalty, presence and frequency penalties are subtractive mechanisms, meaning a fixed mathematical value is subtracted from the target logit.26  
The presence\_penalty acts as a flat, boolean penalty. If a specific token has appeared *at least once* anywhere in the generated text, this fixed penalty value is subtracted from its logit.26 It does not care if the word appeared one time or one hundred times; the penalty is identical. This parameter is specifically designed to encourage the model to introduce completely novel vocabulary and to naturally transition to entirely new topics, rather than dwelling on the current subject.27  
The frequency\_penalty acts as a proportional scaling penalty. The subtracted value is multiplied by the exact number of times the token has previously appeared.26 If the penalty is set to 0.5, and the word "the" has appeared 10 times in the prompt, the raw logit is reduced by a massive 5.0. This algorithm specifically prevents the overuse of specific niche terms or repetitive grammatical tenses, gradually forcing the model to dig into its latent space to find suitable synonyms as a conversation progresses.  
To effectively implement these degeneration controls in the UI, the fundamental distinction between these parameters warrants grouping them in a dedicated Adw.PreferencesGroup titled "Degeneration and Loop Mitigation".6 The repeat\_last\_n parameter requires an integer Adw.SpinRow allowing values from \-1 up to the max context size. The repeat\_penalty requires a float Adw.SpinRow with a baseline of 1.0, typically ranging from 1.0 to 2.0.4 Because the subtractive penalties are slightly more nuanced, the presence\_penalty and frequency\_penalty should be float Adw.SpinRow widgets with a baseline of 0.0, ranging from 0.0 to 2.0 26, potentially tucked behind an expander to reduce visual clutter.

## **GNOME GSettings Backend Architecture**

To successfully persist this vast array of Ollama API parameters across system reboots and GNOME sessions, the extension must rigorously define them in a gschema.xml file.6 Unlike simpler, string-based configuration files found in other desktop environments, GNOME's GSettings utilizes the highly optimized GVariant type system, which enforces strict, statically typed data architectures. Providing the wrong data type from the UI to the GSettings backend, or subsequently passing a string instead of a float in the JSON payload to the Ollama API, will cause the internal JSON parser to fail, resulting in a HTTP 400 Bad Request error.  
By GNOME architectural standards, the schema ID must follow the strict reverse-DNS pattern org.gnome.shell.extensions.\<extension-name\>.6 A properly structured, robust XML schema for this AI harness must utilize type="d" (double precision) for all floating-point values, type="i" for integers, type="b" for booleans, and type="s" for text strings (such as the Base URL and Model name).16

XML  
\<?xml version="1.0" encoding="UTF-8"?\>  
\<schemalist\>  
  \<schema id="org.gnome.shell.extensions.gnome-ai-harness" path="/org/gnome/shell/extensions/gnome-ai-harness/"\>  
      
    \<key name="base-url" type="s"\>  
      \<default\>"http://127.0.0.1:11434"\</default\>  
    \</key\>  
    \<key name="model-name" type="s"\>  
      \<default\>"llama3"\</default\>  
    \</key\>  
    \<key name="keep-alive" type="s"\>  
      \<default\>"5m"\</default\>  
    \</key\>

    \<key name="num-ctx" type="i"\>  
      \<default\>4096\</default\>  
    \</key\>  
    \<key name="num-predict" type="i"\>  
      \<default\>-1\</default\>  
    \</key\>  
    \<key name="num-gpu" type="i"\>  
      \<default\>-1\</default\>  
    \</key\>  
    \<key name="num-thread" type="i"\>  
      \<default\>8\</default\>  
    \</key\>  
    \<key name="top-k" type="i"\>  
      \<default\>40\</default\>  
    \</key\>  
    \<key name="mirostat" type="i"\>  
      \<default\>0\</default\>  
    \</key\>  
    \<key name="repeat-last-n" type="i"\>  
      \<default\>64\</default\>  
    \</key\>

    \<key name="temperature" type="d"\>  
      \<default\>0.8\</default\>  
    \</key\>  
    \<key name="min-p" type="d"\>  
      \<default\>0.05\</default\>  
    \</key\>  
    \<key name="top-p" type="d"\>  
      \<default\>0.90\</default\>  
    \</key\>  
    \<key name="repeat-penalty" type="d"\>  
      \<default\>1.1\</default\>  
    \</key\>  
    \<key name="presence-penalty" type="d"\>  
      \<default\>0.0\</default\>  
    \</key\>  
    \<key name="frequency-penalty" type="d"\>  
      \<default\>0.0\</default\>  
    \</key\>  
    \<key name="mirostat-tau" type="d"\>  
      \<default\>5.0\</default\>  
    \</key\>  
    \<key name="mirostat-eta" type="d"\>  
      \<default\>0.1\</default\>  
    \</key\>

    \<key name="use-mmap" type="b"\>  
      \<default\>true\</default\>  
    \</key\>  
    \<key name="use-mlock" type="b"\>  
      \<default\>false\</default\>  
    \</key\>

  \</schema\>  
\</schemalist\>

A critical architectural note for developers: GSettings key names conventionally use dashes (e.g., top-p, min-p), while the external Ollama API strictly requires underscores (e.g., top\_p, min\_p). The extension's internal JavaScript logic must actively map and replace these characters when converting the GSettings object into the finalized JSON payload for the network POST request.2

## **Libadwaita Interface Construction and Data Binding**

With the backend data architecture rigidly established, the physical user interface is constructed in the extension's prefs.js file utilizing GTK4 and the Libadwaita (Adw) library.6 Because the sheer volume of LLM parameters discussed above can easily overwhelm a standard desktop user, semantic grouping and visual hierarchy are absolutely vital to the success of the harness.  
Modern GNOME extensions utilize an Adw.PreferencesWindow, which acts as the root container, returning an assembly of Adw.PreferencesPage objects representing distinct tabs or views.29

### **Structuring the Views**

To prevent visual clutter, the interface should be divided into two primary Adw.PreferencesPage tabs: "Connection & Hardware" and "Model Behavior".  
**Page 1: Connection & Hardware**  
This page handles routing and how the model physically impacts the host machine.

* **Group: Server Configuration.** This houses the existing Base URL and Model inputs using Adw.EntryRow widgets, and the Keep Alive duration.  
* **Group: Memory Allocation.**  
  * An Adw.SwitchRow for use\_mmap.  
  * An Adw.ExpanderRow containing use\_mlock, featuring a subtitle warning the user about potential system freezes if RAM is overcommitted.8  
* **Group: Compute Power.**  
  * An Adw.SpinRow for num\_thread.15  
  * An Adw.SpinRow for num\_gpu.  
* **Group: Context Limits.**  
  * An Adw.ComboRow for num\_ctx with predefined standard sizes.  
  * An Adw.SpinRow for num\_predict.

**Page 2: Model Behavior** This page directly constructs the options JSON injected into the API.1

* **Group: Static Probabilities.**  
  * An Adw.SpinRow for temperature (0.0 to 2.0).  
  * An Adw.SpinRow for min\_p (0.0 to 1.0). The subtitle must explicitly read: "Alternative to Top-P. Establishes a probability floor based on the most likely token".15  
* **Group: Dynamic Entropy (Mirostat).**  
  * An Adw.ComboRow for mirostat (Disabled, Mirostat 1.0, Mirostat 2.0).  
  * Nested Adw.SpinRow widgets for mirostat\_tau and mirostat\_eta that only become visible or sensitive when the primary ComboRow is actively engaged.24  
* **Group: Degeneration Penalties.**  
  * An Adw.SpinRow for repeat\_penalty.4  
  * An Adw.ExpanderRow containing the subtractive presence\_penalty and frequency\_penalty to hide esoteric mathematical logic from average users.10

### **Bi-Directional UI Data Binding**

In the GTK4/GJS ecosystem, the visual state of an Adw.SpinRow or Adw.ComboRow must be bound bi-directionally to the underlying GSettings key using the Gio.Settings.bind() method.6 This mechanism ensures that if the setting is modified externally (for instance, via the dconf command line tool by a system administrator), the UI updates instantly and automatically without requiring a manual refresh.

JavaScript  
window.\_settings \= this.getSettings();

// Example UI mapping for a high-precision float parameter  
const tempRow \= new Adw.SpinRow({  
    title: \_('Temperature'),  
    subtitle: \_('Controls output randomness. Lower is more deterministic.'),  
    adjustment: new Gtk.Adjustment({  
        lower: 0.0,  
        upper: 2.0,  
        step\_increment: 0.05,  
        page\_increment: 0.5,  
    }),  
    digits: 2  
});

// Bind the GSettings double to the SpinRow's visual value property  
window.\_settings.bind(  
    'temperature',   
    tempRow,   
    'value',   
    Gio.SettingsBindFlags.DEFAULT  
);

| API Parameter | XML Data Type | Valid Range | Recommended Adw Widget | Primary Function |
| :---- | :---- | :---- | :---- | :---- |
| use\_mmap | Boolean (b) | True/False | Adw.SwitchRow | Controls memory mapped files. |
| num\_ctx | Integer (i) | 1024 \- 128k+ | Adw.ComboRow | Total context capacity. |
| temperature | Float (d) | 0.0 \- 2.0 | Adw.SpinRow (step: 0.05) | Flattens the probability distribution. |
| min\_p | Float (d) | 0.0 \- 1.0 | Adw.SpinRow (step: 0.01) | Dynamic probability floor. |
| repeat\_penalty | Float (d) | 1.0 \- 2.0 | Adw.SpinRow (step: 0.05) | Multiplicative repetition mitigation. |
| mirostat | Integer (i) | 0, 1, 2 | Adw.ComboRow | Dynamic entropy targeting algorithm. |

## **Workload Presets and Harness Optimization**

Exposing the raw mathematical capabilities of the Ollama API is functionally powerful, but it places the immense burden of prompt engineering entirely on the desktop user. A fully perfected GNOME AI harness must include higher-level abstractions that manipulate these low-level settings automatically.  
The extension should feature a master Adw.ComboRow at the top of the interface labeled "Workload Preset". Changing this preset programmatically alters the underlying GSettings values en masse, instantly re-configuring the entire API options payload. Based on established computational linguistics benchmarks and optimal parameter combinations, the following algorithmic matrices should be hardcoded into the extension's logic to provide a flawless out-of-the-box experience 22:

1. **Deterministic Programming (Code Generation):** Generating code requires absolute syntactic precision. Hallucinations or "creative" logic result in broken compilation.  
   * temperature: 0.1 (Highly focused).  
   * min\_p: 0.05 (Aggressively filters improbable tokens).  
   * top\_p: 1.0 (Disabled entirely in favor of min\_p).  
   * repeat\_penalty: 1.0 (Disabled. Code relies heavily on repeating syntax, variables, spaces, and brackets. Penalizing repetition severely breaks code structure).22  
2. **Factual Query / RAG (Retrieval-Augmented Generation):** Used when querying local documents. Requires strict adherence to facts with minor conversational flexibility.  
   * temperature: 0.3.  
   * min\_p: 0.05.  
   * repeat\_penalty: 1.05.22  
3. **Creative Ideation / Drafting:** Requires high linguistic diversity, synonym exploration, and novel concept generation.  
   * temperature: 1.1 (Flattens distribution for creativity).  
   * min\_p: 0.05 (Maintains a thin safety net against total gibberish).  
   * presence\_penalty: 0.2 (Subtractive penalty that strongly encourages the model to drop current subjects and transition to new topics).26  
   * repeat\_penalty: 1.1.22  
4. **JSON Mode / Structured Data Extraction:** Used when the harness needs to parse data for other GNOME applications.  
   * temperature: 0.0 (Absolute determinism).  
   * format: "json" (A top-level API parameter that forces the model to only output valid JSON characters).1

By structurally designing the GNOME extension to dynamically compile the comprehensive options JSON object 1 via strongly typed GSettings 16 and wrapping them in intuitive, reactive Libadwaita bounds 15, the desktop harness completely encapsulates the vast backend capabilities of the Ollama API. It translates raw mathematical sampling mechanics, memory allocation risks, and degeneration algorithms into an accessible, natively integrated Linux desktop experience, perfecting the bridge between the user and the local intelligence engine.

#### **Works cited**

1. API Reference \- Ollama English Documentation, accessed May 28, 2026, [https://ollama.readthedocs.io/en/api/](https://ollama.readthedocs.io/en/api/)  
2. ollama/docs/api.md at main \- GitHub, accessed May 28, 2026, [https://github.com/ollama/ollama/blob/main/docs/api.md?plain=1](https://github.com/ollama/ollama/blob/main/docs/api.md?plain=1)  
3. ollama-ollama/docs/modelfile.md at main · lloydchang/ollama-ollama \- GitHub, accessed May 28, 2026, [https://github.com/lloydchang/ollama-ollama/blob/main/docs/modelfile.md](https://github.com/lloydchang/ollama-ollama/blob/main/docs/modelfile.md)  
4. Modelfile Reference \- Ollama, accessed May 28, 2026, [https://docs.ollama.com/modelfile](https://docs.ollama.com/modelfile)  
5. GitHub \- ollama/ollama: Get up and running with Kimi-K2.5, GLM-5, MiniMax, DeepSeek, gpt-oss, Qwen, Gemma and other models., accessed May 28, 2026, [https://github.com/ollama/ollama](https://github.com/ollama/ollama)  
6. Preferences \- GNOME JavaScript, accessed May 28, 2026, [https://gjs.guide/extensions/development/preferences.html](https://gjs.guide/extensions/development/preferences.html)  
7. ollama/docs/api.md at main \- GitHub, accessed May 28, 2026, [https://github.com/ollama/ollama/blob/main/docs/api.md](https://github.com/ollama/ollama/blob/main/docs/api.md)  
8. advanced parameters documentation. · open-webui open-webui · Discussion \#3794 \- GitHub, accessed May 28, 2026, [https://github.com/open-webui/open-webui/discussions/3794](https://github.com/open-webui/open-webui/discussions/3794)  
9. \[QUESTION\] Why is gpu not using full power or mid to 80% while processing requests ? · Issue \#8850 \- GitHub, accessed May 28, 2026, [https://github.com/ollama/ollama/issues/8850](https://github.com/ollama/ollama/issues/8850)  
10. Adw.ExpanderRow, accessed May 28, 2026, [https://gnome.pages.gitlab.gnome.org/libadwaita/doc/1.3/class.ExpanderRow.html](https://gnome.pages.gitlab.gnome.org/libadwaita/doc/1.3/class.ExpanderRow.html)  
11. Continue doesn't allow setting penalty parameters for Ollama provider \#3053 \- GitHub, accessed May 28, 2026, [https://github.com/continuedev/continue/issues/3053](https://github.com/continuedev/continue/issues/3053)  
12. Text Generation Documentation · Issue \#5946 \- GitHub, accessed May 28, 2026, [https://github.com/ollama/ollama/issues/5946](https://github.com/ollama/ollama/issues/5946)  
13. How to Create Custom Modelfiles in Ollama \- OneUptime, accessed May 28, 2026, [https://oneuptime.com/blog/post/2026-02-02-ollama-custom-modelfiles/view](https://oneuptime.com/blog/post/2026-02-02-ollama-custom-modelfiles/view)  
14. ollama-test-issues-tempates/docs/modelfile.md at main \- GitHub, accessed May 28, 2026, [https://github.com/bmizerany/ollama-test-issues-tempates/blob/main/docs/modelfile.md](https://github.com/bmizerany/ollama-test-issues-tempates/blob/main/docs/modelfile.md)  
15. Adw.SpinRow, accessed May 28, 2026, [https://gnome.pages.gitlab.gnome.org/libadwaita/doc/main/class.SpinRow.html](https://gnome.pages.gitlab.gnome.org/libadwaita/doc/main/class.SpinRow.html)  
16. GSettings \- manpagez, accessed May 28, 2026, [https://www.manpagez.com/html/gio/gio-2.38.1/GSettings.php](https://www.manpagez.com/html/gio/gio-2.38.1/GSettings.php)  
17. Ollama endpoints options parameter | by Laurent Kubaski \- Medium, accessed May 28, 2026, [https://medium.com/@laurentkubaski/ollama-model-options-0eee31c902d3](https://medium.com/@laurentkubaski/ollama-model-options-0eee31c902d3)  
18. Understanding "Tokens To Keep On Context Refresh (num\_keep)" : r/ollama \- Reddit, accessed May 28, 2026, [https://www.reddit.com/r/ollama/comments/1hgzel7/understanding\_tokens\_to\_keep\_on\_context\_refresh/](https://www.reddit.com/r/ollama/comments/1hgzel7/understanding_tokens_to_keep_on_context_refresh/)  
19. alpernae/qwen2.5-auditor \- Ollama, accessed May 28, 2026, [https://ollama.com/alpernae/qwen2.5-auditor](https://ollama.com/alpernae/qwen2.5-auditor)  
20. LLM Settings \- Prompt Engineering Guide, accessed May 28, 2026, [https://www.promptingguide.ai/introduction/settings](https://www.promptingguide.ai/introduction/settings)  
21. Confused about temperature, top\_k, top\_p, repetition\_penalty, frequency\_penalty, presence\_penalty? Me too, until now\! : r/LocalLLaMA \- Reddit, accessed May 28, 2026, [https://www.reddit.com/r/LocalLLaMA/comments/157djvv/confused\_about\_temperature\_top\_k\_top\_p\_repetition/](https://www.reddit.com/r/LocalLLaMA/comments/157djvv/confused_about_temperature_top_k_top_p_repetition/)  
22. LLM Sampling Parameters Explained (2026): Temperature, top-p, min-p, DRY, XTC, accessed May 28, 2026, [https://localaimaster.com/blog/llm-sampling-parameters-explained](https://localaimaster.com/blog/llm-sampling-parameters-explained)  
23. LLM Sampling Parameters Guide \- smcleod.net, accessed May 28, 2026, [https://smcleod.net/2025/04/llm-sampling-parameters-guide/](https://smcleod.net/2025/04/llm-sampling-parameters-guide/)  
24. docs/modelfile.md · 36666c214270b7acf8d696a5c92f2fe33cfa14b8 · Till-Ole Herbst / Ollama \- GitLab, accessed May 28, 2026, [https://gitlab.informatik.uni-halle.de/ambcj/ollama/-/blob/36666c214270b7acf8d696a5c92f2fe33cfa14b8/docs/modelfile.md](https://gitlab.informatik.uni-halle.de/ambcj/ollama/-/blob/36666c214270b7acf8d696a5c92f2fe33cfa14b8/docs/modelfile.md)  
25. Modelfile Reference \- Ollama English Documentation, accessed May 28, 2026, [https://ollama.readthedocs.io/en/modelfile/](https://ollama.readthedocs.io/en/modelfile/)  
26. Repetition penalties are terribly implemented \- A short explanation and solution \- Reddit, accessed May 28, 2026, [https://www.reddit.com/r/LocalLLaMA/comments/1g383mq/repetition\_penalties\_are\_terribly\_implemented\_a/](https://www.reddit.com/r/LocalLLaMA/comments/1g383mq/repetition_penalties_are_terribly_implemented_a/)  
27. Tweaking Local Language Model Settings with Ollama \- KDnuggets, accessed May 28, 2026, [https://www.kdnuggets.com/tweaking-local-language-model-settings-with-ollama](https://www.kdnuggets.com/tweaking-local-language-model-settings-with-ollama)  
28. Gio.Settings \- GTK Documentation, accessed May 28, 2026, [https://docs.gtk.org/gio/class.Settings.html](https://docs.gtk.org/gio/class.Settings.html)  
29. Port Extensions to GNOME Shell 42, accessed May 28, 2026, [https://gjs.guide/extensions/upgrading/gnome-shell-42.html](https://gjs.guide/extensions/upgrading/gnome-shell-42.html)

[image1]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABMAAAAaCAYAAABVX2cEAAAAyUlEQVR4XmNgGAWUgglA/B8LRga/0OTqUaUxATZDYICFASKXgCaOE4AU/0UXBAJpIH6GLogPWDBADOtFE88H4qloYgTBVgaIYfxIYheB2ASJTzRADi9GBoh3CxHSpAGQQb+BWBuIn0P5uCIDLwB5BaTxDQMifL5CxSRgiogFWxggGo2QxPShYveRxIgCuLyESxwvgIUXOmhjgMj1o0vgAtYMEA196BJQQJTrsoD4EgNC8RMgPoIkzwzEt5DkvwHxQST5UTAKhi4AAL4VPF3UvJ/pAAAAAElFTkSuQmCC>

[image2]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAaCAYAAAC+aNwHAAAArElEQVR4XmNgGAXooA6IfwHxXyD+B8T/ofQfIP4GxOuAmBWuGg8AaQRhdLCPASJuiS6BDkCKQDZiA7gMhwMVBoiCBjRxGCBowEIGiAJOdAkgCGWAyF1Gl0AG+GzAJwcHIAU/kfjMQOzDAImND0jiWIE8A8SAs0A8AQlXATEbkjqcYAEDxACQQWQBovyID1BkgAYDRPMcdAlCIA6IrzIgbH8NxCdQVIyCUUBrAACYFjAbgVJLAgAAAABJRU5ErkJggg==>